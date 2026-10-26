package agent

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/agent/spool"
	"github.com/GODOSTROYER/zenith/go/internal/agent/update"
	"github.com/GODOSTROYER/zenith/go/internal/protocol"
	updatecontrol "github.com/GODOSTROYER/zenith/go/internal/runner/update"
)

// Process exit codes shared by both binaries.
const (
	ExitOK              = 0
	ExitError           = 1
	ExitUsage           = 2
	ExitRevoked         = 3 // the control plane revoked this agent
	ExitUpgradeRequired = 4 // the control plane requires a newer protocol version
)

// ResultBody is the body of POST .../jobs/{jti}/result.
type ResultBody struct {
	// Status is succeeded | failed | rejected | timed_out.
	Status     string `json:"status"`
	StartedAt  string `json:"startedAt"`
	FinishedAt string `json:"finishedAt"`
	ExitCode   *int   `json:"exitCode,omitempty"`
	Result     any    `json:"result,omitempty"`
	Error      string `json:"error,omitempty"`
}

// Result statuses.
const (
	StatusSucceeded = "succeeded"
	StatusFailed    = "failed"
	StatusRejected  = "rejected"
	StatusTimedOut  = "timed_out"
)

// Job is one verified unit of work.
type Job interface {
	// ID is the job / request id (`jti`).
	ID() string
	// Run executes the job. ctx is cancelled on revocation or a hard
	// shutdown; the job applies its own timeout. It must always return a
	// result (never panic the agent).
	Run(ctx context.Context, logs LogSink) ResultBody
}

// Rejection reports a job that failed verification or validation. ID may be
// empty when the token could not even be parsed (nothing is reported then).
type Rejection struct {
	ID      string
	Code    string
	Message string
}

// Processor plugs a job kind implementation into the loop.
type Processor interface {
	// Verify authenticates and validates a dispatched compact JWS.
	Verify(ctx context.Context, compact string) (Job, *Rejection)
	// Capabilities lists what this agent offers (registration, heartbeat).
	Capabilities() []string
}

// Options configure an Agent.
type Options struct {
	Kind      Kind
	Config    *Common
	Identity  *Identity
	Keys      *protocol.KeySet // shared with the Processor's verifier
	Processor Processor
	Version   string
	Logger    *slog.Logger

	// Test hooks (zero values use the configured / real behavior).
	HTTPClient     *http.Client
	HeartbeatEvery time.Duration
	Now            func() time.Time
	// UpdateHTTPClient overrides the release-channel client (tests).
	UpdateHTTPClient *http.Client
}

// Agent runs the poll / heartbeat / result loop.
type Agent struct {
	opts   Options
	cfg    *Common
	client *Client
	log    *slog.Logger
	keys   *protocol.KeySet

	// Only rotation writes shared trust. Readers continue using the same KeySet.
	rotationMu sync.Mutex

	sem       chan struct{}
	slotFreed chan struct{}
	wg        sync.WaitGroup
	pending   atomic.Int32 // dispatched and not finished (queued + running)
	running   atomic.Int32 // executing now
	revoked   atomic.Bool
	pollSec   atomic.Int32

	// Lifecycle: delivery, reconnect and update state (lifecycle.go).
	conn          *connTracker
	spool         *spool.Spool
	updater       *update.Manager
	updateControl *updatecontrol.Controller
	inflightMu    sync.Mutex
	inflight      map[string]struct{}
	replayed      atomic.Int64
	hbOK          atomic.Bool // an authenticated heartbeat succeeded this run
	pollOK        atomic.Bool // an authenticated poll succeeded this run
	exitOverride  atomic.Int32

	stopLoop   context.CancelFunc
	loopCtx    context.Context // cancelled when the agent stops taking work
	jobsCtx    context.Context
	cancelJobs context.CancelFunc
	postCtx    context.Context
	cancelPost context.CancelFunc
}

// New builds an Agent.
func New(opts Options) (*Agent, error) {
	if opts.Config == nil || opts.Identity == nil || opts.Processor == nil || opts.Keys == nil {
		return nil, errors.New("agent: Config, Identity, Keys and Processor are required")
	}
	// Keep registration metadata immutable for the running agent and its request paths.
	identity := *opts.Identity
	identity.ControlPlaneKeys = append([]protocol.KeyEntry(nil), opts.Identity.ControlPlaneKeys...)
	opts.Identity = &identity
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	priv, err := opts.Identity.PrivateKeyBytes()
	if err != nil {
		return nil, err
	}
	if trimSlash(opts.Identity.ControlPlaneURL) != trimSlash(opts.Config.ControlPlane.URL) {
		return nil, fmt.Errorf("this agent is registered with %s but the config points at %s; re-register or fix controlPlane.url", opts.Identity.ControlPlaneURL, opts.Config.ControlPlane.URL)
	}
	httpc := opts.HTTPClient
	if httpc == nil {
		tlsCfg, err := BuildTLS(opts.Config.TLS)
		if err != nil {
			return nil, err
		}
		httpc = NewHTTPClient(tlsCfg)
	}
	ua := "zenith-" + opts.Kind.Name + "/" + opts.Version
	client, err := NewClient(opts.Config.ControlPlane.URL, httpc, priv, opts.Identity.ID, opts.Kind.Protocol, ua, opts.Now)
	if err != nil {
		return nil, err
	}
	a := &Agent{
		opts:      opts,
		cfg:       opts.Config,
		client:    client,
		log:       opts.Logger.With("agent", opts.Identity.ID),
		keys:      opts.Keys,
		sem:       make(chan struct{}, opts.Config.MaxConcurrent),
		slotFreed: make(chan struct{}, 1),
		inflight:  map[string]struct{}{},
	}
	a.conn = newConnTracker(a.now)
	if sp, err := newSpool(opts.Config, a.now); err == nil {
		a.spool = sp
	} else if !errors.Is(err, errNoState) {
		return nil, fmt.Errorf("open result spool: %w", err)
	}
	a.updater = newUpdater(opts.Config, opts.Kind, opts.Version, opts.UpdateHTTPClient, opts.Now)
	if opts.Config.Update.Enabled {
		control, err := updatecontrol.Open(opts.Config.StateDir, updatecontrol.Binding{WorkspaceID: opts.Identity.WorkspaceID, AgentID: opts.Identity.ID, Kind: opts.Kind.Name}, opts.Now)
		if err != nil {
			return nil, fmt.Errorf("open durable update control: %w", err)
		}
		a.updateControl = control
	}
	poll := opts.Identity.PollIntervalSec
	if poll <= 0 {
		poll = 5
	}
	a.pollSec.Store(int32(clampInt(poll, 1, 300)))
	return a, nil
}

func trimSlash(s string) string {
	for len(s) > 0 && s[len(s)-1] == '/' {
		s = s[:len(s)-1]
	}
	return s
}

func clampInt(v, lo, hi int) int { return max(lo, min(hi, v)) }

func (a *Agent) now() time.Time {
	if a.opts.Now != nil {
		return a.opts.Now()
	}
	return time.Now()
}

func (a *Agent) itemPath(suffix string) string {
	return protocol.APIPrefix + "/" + a.opts.Kind.Collection + "/" + a.opts.Identity.ID + suffix
}

// Run blocks until the context is cancelled (graceful shutdown, exit 0),
// the agent is revoked (exit 3) or a terminal error occurs. It never returns
// while jobs it started are still running, except after revocation, when
// jobs are cancelled and their results are not reported.
func (a *Agent) Run(ctx context.Context) int {
	a.jobsCtx, a.cancelJobs = context.WithCancel(context.Background())
	a.postCtx, a.cancelPost = context.WithCancel(context.Background())
	defer a.cancelJobs()
	defer a.cancelPost()
	loopCtx, stop := context.WithCancel(ctx)
	a.stopLoop = stop
	a.loopCtx = loopCtx
	defer stop()

	if a.cfg.StateDir != "" && IsRevokedLocally(a.cfg.StateDir, a.opts.Identity.ID) {
		a.log.Error("this identity was revoked by the control plane earlier; not taking work (register again with a new token to recover)")
		return ExitRevoked
	}

	a.log.Info("agent starting", "kind", a.opts.Kind.Name, "version", a.opts.Version, "capabilities", a.opts.Processor.Capabilities(), "maxConcurrent", a.cfg.MaxConcurrent)

	hbDone := make(chan struct{})
	go func() {
		defer close(hbDone)
		a.heartbeatLoop(loopCtx)
	}()

	bgDone := make(chan struct{})
	go func() {
		defer close(bgDone)
		var bg sync.WaitGroup
		bg.Add(2)
		go func() { defer bg.Done(); a.replayLoop(loopCtx) }()
		go func() { defer bg.Done(); a.updateLoop(loopCtx) }()
		bg.Wait()
	}()

	code := a.pollLoop(loopCtx)
	stop()
	<-hbDone
	<-bgDone

	if a.revoked.Load() {
		a.log.Error("agent was revoked by the control plane; stopping without reporting further results")
		a.cancelJobs()
		a.wg.Wait()
		return ExitRevoked
	}
	a.drain()
	if override := int(a.exitOverride.Load()); override != 0 && ctx.Err() == nil {
		code = override
	}
	a.log.Info("agent stopped", "exitCode", code)
	return code
}

// drain waits for in-flight jobs up to the grace period, then cancels them
// and waits briefly for their (cancelled) results to be posted.
func (a *Agent) drain() {
	if a.pending.Load() == 0 {
		return
	}
	grace := time.Duration(a.cfg.ShutdownGraceSec) * time.Second
	a.log.Info("shutting down; waiting for in-flight jobs", "count", a.pending.Load(), "grace", grace.String())
	done := make(chan struct{})
	go func() { a.wg.Wait(); close(done) }()
	select {
	case <-done:
		return
	case <-time.After(grace):
	}
	a.log.Warn("grace period elapsed; cancelling in-flight jobs")
	a.cancelJobs()
	select {
	case <-done:
	case <-time.After(20 * time.Second):
		a.log.Error("in-flight jobs did not finish after cancellation")
	}
	a.cancelPost()
}

func (a *Agent) markRevoked() {
	if a.revoked.CompareAndSwap(false, true) {
		a.log.Error("control plane revoked this agent")
		if a.cfg.StateDir != "" {
			if err := writeRevokedMarker(a.cfg.StateDir, a.opts.Identity.ID, a.now()); err != nil {
				a.log.Error("could not persist the revocation marker", "err", err)
			}
		}
		a.cancelJobs()
		a.cancelPost()
		if a.stopLoop != nil {
			a.stopLoop()
		}
	}
}

func (a *Agent) free() int { return a.cfg.MaxConcurrent - int(a.pending.Load()) }

type pollRequest struct {
	Max     int `json:"max"`
	WaitSec int `json:"waitSec"`
}

type pollResponse struct {
	Jobs            []string `json:"jobs"`
	PollIntervalSec int      `json:"pollIntervalSec"`
}

func (a *Agent) pollLoop(ctx context.Context) int {
	bo := NewBackoff()
	failures := 0
	for ctx.Err() == nil {
		free := a.free()
		if free <= 0 {
			select {
			case <-a.slotFreed:
			case <-time.After(time.Second):
			case <-ctx.Done():
			}
			continue
		}
		started := a.now()
		wait := a.cfg.PollWaitSec
		var resp pollResponse
		_, err := a.client.Do(ctx, http.MethodPost, a.itemPath("/poll"), pollRequest{Max: min(free, 10), WaitSec: wait}, &resp, time.Duration(wait+15)*time.Second, 64<<20)
		switch {
		case err == nil:
			bo.Reset()
			failures = 0
			a.pollOK.Store(true)
			a.noteSuccess()
			if resp.PollIntervalSec > 0 {
				a.pollSec.Store(int32(clampInt(resp.PollIntervalSec, 1, 300)))
			}
			for _, tok := range resp.Jobs {
				a.dispatch(tok)
			}
			if len(resp.Jobs) > 0 {
				continue // more work may be waiting
			}
		case errors.Is(err, ErrRevoked):
			a.markRevoked()
			return ExitRevoked
		case errors.Is(err, ErrUpgradeRequired):
			a.log.Error("the control plane no longer accepts this agent's protocol version; upgrade the agent")
			return ExitUpgradeRequired
		case ctx.Err() != nil:
			return ExitOK
		default:
			failures++
			a.noteFailure()
			d := bo.Next()
			if failures == 1 || failures%10 == 0 {
				a.log.Warn("poll failed; retrying with backoff", "err", err, "retryIn", d.String(), "consecutiveFailures", failures)
			}
			if !sleepCtx(ctx, d) {
				return ExitOK
			}
			continue
		}
		// Honor the minimum poll gap after an empty poll.
		gap := time.Duration(a.pollSec.Load())*time.Second - a.now().Sub(started)
		if gap > 0 && !sleepCtx(ctx, gap) {
			return ExitOK
		}
	}
	return ExitOK
}

func sleepCtx(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return true
	case <-ctx.Done():
		return false
	}
}

func (a *Agent) dispatch(token string) {
	a.pending.Add(1)
	a.wg.Add(1)
	go a.runOne(token)
}

func (a *Agent) runOne(token string) {
	defer a.wg.Done()
	defer func() {
		a.pending.Add(-1)
		select {
		case a.slotFreed <- struct{}{}:
		default:
		}
	}()
	select {
	case a.sem <- struct{}{}:
		defer func() { <-a.sem }()
	case <-a.jobsCtx.Done():
		return
	}
	a.running.Add(1)
	defer a.running.Add(-1)
	if a.jobsCtx.Err() != nil {
		return
	}

	job, rej := a.safeVerify(token)
	if rej != nil {
		a.reportRejection(rej)
		return
	}
	jlog := a.log.With("job", job.ID())
	jlog.Info("job accepted")
	streamer := newLogStreamer(func(ctx context.Context, b logBatch) error { return a.postLogs(ctx, job.ID(), b) }, jlog, a.opts.Now)
	res := a.safeRun(job, streamer)
	streamer.Close()
	if a.revoked.Load() {
		return
	}
	jlog.Info("job finished", "status", res.Status)
	a.postResult(job.ID(), res)
}

func (a *Agent) safeVerify(token string) (job Job, rej *Rejection) {
	defer func() {
		if r := recover(); r != nil {
			a.log.Error("panic while verifying a job", "panic", fmt.Sprint(r))
			job, rej = nil, &Rejection{ID: protocol.UnverifiedJTI(token), Code: protocol.CodeInternal, Message: "internal error while verifying the job"}
		}
	}()
	return a.opts.Processor.Verify(a.jobsCtx, token)
}

func (a *Agent) safeRun(job Job, sink LogSink) (res ResultBody) {
	started := a.now().UTC()
	defer func() {
		if r := recover(); r != nil {
			a.log.Error("panic while running a job", "job", job.ID(), "panic", fmt.Sprint(r))
			res = ResultBody{Status: StatusFailed, StartedAt: started.Format(time.RFC3339Nano), FinishedAt: a.now().UTC().Format(time.RFC3339Nano), Error: "internal_error: the agent hit an unexpected error while running the job"}
		}
	}()
	gate := func(ctx context.Context) error { return a.checkGrant(ctx, job.ID()) }
	return job.Run(WithStepGate(a.jobsCtx, gate), sink)
}

func (a *Agent) reportRejection(rej *Rejection) {
	a.log.Warn("job rejected", "job", rej.ID, "code", rej.Code, "reason", rej.Message)
	if rej.ID == "" || a.revoked.Load() {
		return
	}
	now := a.now().UTC().Format(time.RFC3339Nano)
	a.postResult(rej.ID, ResultBody{
		Status:     StatusRejected,
		StartedAt:  now,
		FinishedAt: now,
		Error:      rej.Code + ": " + rej.Message,
		Result:     map[string]any{"reason": rej.Code},
	})
}

// postResult delivers a finished job's result. The result is made durable in
// the local spool FIRST, then posted with bounded retry. It leaves the spool
// only once the control plane accepted it, said the job is already settled
// (409: the control plane accepts one result per job), or refused it
// terminally. If every attempt fails, or the agent is stopping, the result
// stays spooled and the replay loop delivers it on the next reconnect or start.
func (a *Agent) postResult(jti string, body ResultBody) {
	if n, _ := encodedSize(body); n > int(a.cfg.MaxResultBytes) || n < 0 {
		a.log.Warn("result exceeds maxResultBytes; reporting failure instead", "job", jti, "bytes", n, "max", a.cfg.MaxResultBytes)
		body = ResultBody{
			Status: StatusFailed, StartedAt: body.StartedAt, FinishedAt: body.FinishedAt, ExitCode: body.ExitCode,
			Error: fmt.Sprintf("result_too_large: the result is %d bytes, above the agent limit of %d (maxResultBytes)", n, a.cfg.MaxResultBytes),
		}
	}
	spooled := false
	if a.spool != nil {
		if _, err := a.spool.Put(a.opts.Identity.ID, jti, body); err != nil {
			a.log.Error("could not spool the result durably; retrying from memory only", "job", jti, "err", err)
		} else {
			spooled = true
		}
	}
	if !a.markInflight(jti) {
		return // the replay loop is already delivering it
	}
	defer a.clearInflight(jti)
	bo := &Backoff{Min: time.Second, Max: 30 * time.Second}
	// A spooled result is safe on disk, so once the agent stops taking work
	// there is no point holding the shutdown open to retry it: the next start
	// or reconnect replays it. An unspooled one keeps the old drain behaviour.
	waitCtx := a.postCtx
	if spooled {
		waitCtx = a.loopCtx
	}
	for attempt := 1; attempt <= 12; attempt++ {
		if a.postCtx.Err() != nil {
			a.log.Warn("not posting result now: agent is stopping", "job", jti, "spooled", spooled)
			return
		}
		done, err := a.sendResult(a.postCtx, jti, body)
		if done {
			if spooled {
				if err == nil {
					_ = a.spool.Remove(jti)
				} else {
					a.spool.Quarantine(jti, "refused")
				}
			}
			return
		}
		if errors.Is(err, ErrRevoked) {
			return
		}
		if spooled && a.loopCtx.Err() != nil {
			a.log.Warn("could not post the result before shutdown; it stays in the durable spool", "job", jti, "err", err)
			return
		}
		d := bo.Next()
		a.log.Warn("posting result failed; retrying", "job", jti, "attempt", attempt, "err", err, "retryIn", d.String())
		if !sleepCtx(waitCtx, d) {
			return
		}
	}
	if spooled {
		a.log.Warn("could not post the result yet; it stays in the durable spool and is replayed on reconnect", "job", jti)
	} else {
		a.log.Error("giving up posting result after repeated failures; the control plane will mark the job uncertain", "job", jti)
	}
}

// sendResult makes one attempt. done is true when the result needs no more
// attempts: accepted or already settled (err nil), or refused terminally (err
// set). done false means retry later (err says why; ErrRevoked after marking
// the agent revoked).
func (a *Agent) sendResult(ctx context.Context, jti string, body ResultBody) (done bool, err error) {
	_, err = a.client.Do(ctx, http.MethodPost, resultPath(a.opts.Kind, a.opts.Identity.ID, jti), body, nil, 30*time.Second, 1<<20)
	var he *HTTPError
	switch {
	case err == nil:
		a.noteSuccess()
		return true, nil
	case errors.Is(err, ErrRevoked):
		a.markRevoked()
		return false, err
	case errors.As(err, &he) && he.Status == http.StatusConflict:
		a.noteSuccess()
		a.log.Info("result not accepted: job already settled", "job", jti, "code", he.Code)
		return true, nil
	case errors.As(err, &he) && he.Status >= 400 && he.Status < 500 && he.Status != http.StatusRequestTimeout && he.Status != http.StatusTooManyRequests:
		a.noteSuccess()
		a.log.Error("control plane refused the result; not retrying", "job", jti, "status", he.Status, "code", he.Code)
		return true, err
	}
	a.noteFailure()
	return false, err
}

func (a *Agent) noteSuccess() {
	if a.conn.success() {
		a.log.Info("connection to the control plane recovered")
	}
}

func (a *Agent) noteFailure() {
	if a.conn.failure() {
		a.log.Warn("control plane unreachable; running offline (results are spooled, work resumes on reconnect)")
	}
}

type heartbeatRequest struct {
	Version      string   `json:"version"`
	Capabilities []string `json:"capabilities"`
	Running      int      `json:"running"`
	Host         HostInfo `json:"host"`
	// Lifecycle reports connection, result-spool and update state so the
	// control plane can show offline / recovering / rolled-back honestly.
	Lifecycle          lifecycleReport `json:"lifecycle"`
	UpdateControlNonce string          `json:"updateControlNonce,omitempty"`
}

type heartbeatResponse struct {
	UpdateControl   string              `json:"updateControl"`
	Revoked         bool                `json:"revoked"`
	NextKeys        []protocol.KeyEntry `json:"nextKeys"`
	PollIntervalSec int                 `json:"pollIntervalSec"`
}

func (a *Agent) heartbeatLoop(ctx context.Context) {
	every := time.Duration(a.cfg.HeartbeatSec) * time.Second
	if a.opts.HeartbeatEvery > 0 {
		every = a.opts.HeartbeatEvery
	}
	failures := 0
	for {
		if err := a.heartbeat(ctx); err != nil {
			if errors.Is(err, ErrRevoked) {
				a.markRevoked()
				return
			}
			if ctx.Err() != nil {
				return
			}
			failures++
			a.noteFailure()
			if failures == 1 || failures%10 == 0 {
				a.log.Warn("heartbeat failed", "err", err, "consecutiveFailures", failures)
			}
		} else {
			failures = 0
			a.hbOK.Store(true)
			a.noteSuccess()
		}
		if !sleepCtx(ctx, every) {
			return
		}
	}
}

func (a *Agent) heartbeat(ctx context.Context) error {
	var controlNonce string
	if a.updateControl != nil {
		nonce, err := updatecontrol.Nonce()
		if err != nil {
			return err
		}
		controlNonce = nonce
	}
	var resp heartbeatResponse
	_, err := a.client.Do(ctx, http.MethodPost, a.itemPath("/heartbeat"), heartbeatRequest{
		Version:            a.opts.Version,
		Capabilities:       a.updateCapabilities(),
		UpdateControlNonce: controlNonce,
		Running:            int(a.running.Load()),
		Host:               LocalHost(),
		Lifecycle:          a.lifecycle(),
	}, &resp, 20*time.Second, 1<<20)
	if err != nil {
		return err
	}
	if resp.Revoked {
		return ErrRevoked
	}
	if resp.PollIntervalSec > 0 {
		a.pollSec.Store(int32(clampInt(resp.PollIntervalSec, 1, 300)))
	}
	if len(resp.NextKeys) > 0 {
		a.acceptNextKeys(resp.NextKeys)
	}
	if a.updateControl != nil {
		if err := a.updateControl.Observe(resp.UpdateControl, a.keys, controlNonce); err != nil {
			a.log.Warn("update authority unavailable; retaining the current version")
		}
	}
	return nil
}

const maxPinnedKeys = 8

// acceptNextKeys pins announced rotation keys (delivered over the verified
// TLS channel, at least 24 h before use) and persists them.
func (a *Agent) acceptNextKeys(next []protocol.KeyEntry) {
	a.rotationMu.Lock()
	defer a.rotationMu.Unlock()

	// Validation and merging must not expose new trust before persistence succeeds.
	candidate, err := protocol.NewKeySet(a.keys.Entries())
	if err != nil {
		a.log.Error("could not stage pinned control-plane keys")
		return
	}
	var added []protocol.KeyEntry
	for _, k := range next {
		if pinned, known := candidate.Get(k.Kid); known {
			if protocol.B64Encode(pinned) != k.PublicKey {
				a.log.Warn("ignoring conflicting announced control-plane key")
			}
			continue
		}
		if candidate.Len() >= maxPinnedKeys {
			a.log.Warn("not pinning announced control-plane key: pinned-key limit reached", "kid", k.Kid)
			continue
		}
		if err := candidate.Add(k); err != nil {
			a.log.Warn("ignoring invalid announced control-plane key")
			continue
		}
		added = append(added, k)
	}
	if len(added) == 0 {
		return
	}
	entries := candidate.Entries()
	sort.Slice(entries, func(i, j int) bool { return entries[i].Kid < entries[j].Kid })
	id := *a.opts.Identity
	id.ControlPlaneKeys = entries
	if err := SaveIdentity(a.cfg.StateDir, &id); err != nil {
		a.log.Error("could not persist announced control-plane keys", "err", err)
		return
	}
	for _, k := range added {
		// Candidate validation already succeeded; keep the processor's shared pointer.
		if err := a.keys.Add(k); err != nil {
			a.log.Error("could not publish persisted control-plane key")
			return
		}
		a.log.Info("pinned announced control-plane key", "kid", k.Kid)
	}
}

// Marker is reported only by agents with the installed control loop.
func (a *Agent) updateCapabilities() []string {
	caps := append([]string(nil), a.opts.Processor.Capabilities()...)
	if a.updateControl != nil {
		caps = append(caps, "agent.update.control.v1")
	}
	return caps
}

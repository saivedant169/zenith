package agent_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/agent"
	"github.com/GODOSTROYER/zenith/go/internal/agent/fakecp"
	"github.com/GODOSTROYER/zenith/go/internal/protocol"
)

// stubJob behaviors are encoded in the dispatched "token": "<id>|<behavior>".
type stubProcessor struct {
	running    atomic.Int32
	maxRunning atomic.Int32
	started    chan string
	release    chan struct{}
	verified   atomic.Int32
	// afterStep runs after each completed step of a "steps" job (set before the agent starts).
	afterStep func(jti string, step int)
	mu        sync.Mutex
	steps     map[string][]int
}

// recordStep notes that a "steps" job ran a step, then runs the test hook.
func (p *stubProcessor) recordStep(jti string, step int) {
	p.mu.Lock()
	if p.steps == nil {
		p.steps = map[string][]int{}
	}
	p.steps[jti] = append(p.steps[jti], step)
	p.mu.Unlock()
	if p.afterStep != nil {
		p.afterStep(jti, step)
	}
}

// stepsRun returns the steps a "steps" job actually ran, in order.
func (p *stubProcessor) stepsRun(jti string) []int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]int(nil), p.steps[jti]...)
}

func newStub() *stubProcessor {
	return &stubProcessor{started: make(chan string, 64), release: make(chan struct{})}
}

func (p *stubProcessor) Capabilities() []string { return []string{"probe.tcp", "stub.kind"} }

func (p *stubProcessor) Verify(_ context.Context, token string) (agent.Job, *agent.Rejection) {
	p.verified.Add(1)
	id, behavior, _ := strings.Cut(token, "|")
	if behavior == "unparseable" {
		return nil, &agent.Rejection{ID: "", Code: protocol.CodeMalformed, Message: "garbage"}
	}
	if behavior == "reject" {
		return nil, &agent.Rejection{ID: id, Code: protocol.CodeNotAllowed, Message: "not allowed here"}
	}
	return &stubJob{p: p, id: id, behavior: behavior}, nil
}

type stubJob struct {
	p        *stubProcessor
	id       string
	behavior string
}

func (j *stubJob) ID() string { return j.id }

// Inert provider-format fixtures are assembled at runtime, never real credentials.
func inertAccessKey() string {
	return strings.Join([]string{"AK", "IA", "IOSFODNN7", "EXAMPLE"}, "")
}

func inertSecretKey() string {
	return strings.Join([]string{"wJalrXUtnFEMI/", "K7MDENG+bPxRfiCY", "EXAMPLEKEY"}, "")
}

func inertPrivateBody() string {
	return strings.Join([]string{"MIIEvQIBADAN", "BgkqhkiG9w0BA", "QEFAASC", "BKcwggSjAgEAAoIBAQC7"}, "")
}

func (j *stubJob) Run(ctx context.Context, logs agent.LogSink) agent.ResultBody {
	n := j.p.running.Add(1)
	for {
		m := j.p.maxRunning.Load()
		if n <= m || j.p.maxRunning.CompareAndSwap(m, n) {
			break
		}
	}
	defer j.p.running.Add(-1)
	j.p.started <- j.id
	now := time.Now().UTC().Format(time.RFC3339Nano)
	ok := agent.ResultBody{Status: agent.StatusSucceeded, StartedAt: now, FinishedAt: now, Result: map[string]any{"id": j.id}}
	switch {
	case j.behavior == "steps":
		for step := 1; step <= 2; step++ {
			if err := agent.CheckStep(ctx); err != nil {
				return agent.ResultBody{Status: agent.StatusRejected, StartedAt: now, FinishedAt: now, Error: err.Error(), Result: map[string]any{"reason": "grant_not_active"}}
			}
			j.p.recordStep(j.id, step)
		}
	case j.behavior == "panic":
		panic("boom with secret " + inertAccessKey())
	case j.behavior == "bigresult":
		ok.Result = map[string]any{"blob": strings.Repeat("x", 300<<10)}
	case j.behavior == "wait":
		select {
		case <-j.p.release:
		case <-ctx.Done():
			return agent.ResultBody{Status: agent.StatusFailed, StartedAt: now, FinishedAt: now, Error: "cancelled"}
		}
	case strings.HasPrefix(j.behavior, "sleep"):
		var ms int
		fmt.Sscanf(strings.TrimPrefix(j.behavior, "sleep"), "%d", &ms)
		select {
		case <-time.After(time.Duration(ms) * time.Millisecond):
		case <-ctx.Done():
			return agent.ResultBody{Status: agent.StatusFailed, StartedAt: now, FinishedAt: now, Error: "cancelled"}
		}
	case j.behavior == "logs":
		logs.Line("stdout", "starting up")
		logs.Line("stderr", "aws_secret_access_key = "+inertSecretKey())
		logs.Line("info", "key "+inertAccessKey()+" leaked")
		logs.Line("stdout", "-----BEGIN PRIVATE KEY-----")
		logs.Line("stdout", inertPrivateBody())
		logs.Line("stdout", "-----END PRIVATE KEY-----")
		logs.Line("stdout", "done")
	}
	return ok
}

type rig struct {
	t      *testing.T
	fake   *fakecp.Server
	cfg    *agent.Common
	id     *agent.Identity
	keys   *protocol.KeySet
	stub   *stubProcessor
	agent  *agent.Agent
	cancel context.CancelFunc
	exit   chan int
}

func newRig(t *testing.T, mutate func(*agent.Common)) *rig {
	t.Helper()
	fake := fakecp.New(t, "runners", protocol.RunnerProtocol)
	dir := t.TempDir()
	cfg := &agent.Common{
		ControlPlane: agent.ControlPlaneConfig{URL: fake.URL},
		TLS:          agent.TLSConfig{CAFile: fake.CAFile(dir)},
		StateDir:     dir + "/state", Name: "test-runner", PollWaitSec: 0, HeartbeatSec: 30, MaxConcurrent: 4, ShutdownGraceSec: 30,
		MaxResultBytes: 64 << 10,
	}
	cfg.ApplyDefaults(dir + "/state")
	cfg.MaxResultBytes = 64 << 10
	cfg.PollWaitSec = 0
	cfg.Log = agent.LogConfig{Level: "error", Format: "text"}
	if mutate != nil {
		mutate(cfg)
	}
	id, err := agent.Register(context.Background(), cfg, agent.RegisterOptions{Kind: agent.RunnerKind, Token: fake.Token, Version: "test", Capabilities: []string{"probe.tcp"}, UserAgent: "test"})
	if err != nil {
		t.Fatal(err)
	}
	keys, err := protocol.NewKeySet(id.ControlPlaneKeys)
	if err != nil {
		t.Fatal(err)
	}
	return &rig{t: t, fake: fake, cfg: cfg, id: id, keys: keys, stub: newStub()}
}

func (r *rig) start(hb time.Duration) {
	r.t.Helper()
	a, err := agent.New(agent.Options{
		Kind: agent.RunnerKind, Config: r.cfg, Identity: r.id, Keys: r.keys, Processor: r.stub, Version: "test",
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), HeartbeatEvery: hb,
	})
	if err != nil {
		r.t.Fatal(err)
	}
	r.agent = a
	ctx, cancel := context.WithCancel(context.Background())
	r.cancel = cancel
	exit := make(chan int, 1)
	r.exit = exit
	go func() { exit <- a.Run(ctx) }()
	r.t.Cleanup(func() {
		cancel()
		select {
		case <-exit:
		case <-time.After(20 * time.Second):
			r.t.Error("agent did not stop")
		}
	})
}

func (r *rig) waitExit(d time.Duration) int {
	r.t.Helper()
	select {
	case code := <-r.exit:
		r.exit <- code
		return code
	case <-time.After(d):
		r.t.Fatal("agent did not exit in time")
		return -1
	}
}

func (r *rig) noBadRequests() {
	r.t.Helper()
	if bad := r.fake.BadRequests(); len(bad) != 0 {
		r.t.Fatalf("the control plane rejected requests: %v", bad)
	}
}

func TestAgentRunsJobsAndPostsSignedResults(t *testing.T) {
	r := newRig(t, nil)
	r.start(100 * time.Millisecond)
	r.fake.Enqueue("job_1|ok", "job_2|ok", "job_3|reject")
	for _, id := range []string{"job_1", "job_2", "job_3"} {
		if _, ok := r.fake.WaitResult(id, 5*time.Second); !ok {
			t.Fatalf("no result for %s", id)
		}
	}
	res, _ := r.fake.WaitResult("job_1", time.Second)
	if res.Body["status"] != "succeeded" || res.Body["startedAt"] == nil || res.Body["finishedAt"] == nil {
		t.Fatalf("%v", res.Body)
	}
	rej, _ := r.fake.WaitResult("job_3", time.Second)
	if rej.Body["status"] != "rejected" || !strings.Contains(rej.Body["error"].(string), "not_allowed") || rej.Body["result"].(map[string]any)["reason"] != protocol.CodeNotAllowed {
		t.Fatalf("a rejection must carry a status and a reason: %v", rej.Body)
	}
	// heartbeats carry version, capabilities, running and host
	time.Sleep(300 * time.Millisecond)
	hbs := r.fake.Heartbeats()
	if len(hbs) < 2 {
		t.Fatalf("heartbeats: %d", len(hbs))
	}
	hb := hbs[0]
	if hb["version"] != "test" || hb["host"].(map[string]any)["os"] == nil || len(hb["capabilities"].([]any)) != 2 {
		t.Fatalf("%v", hb)
	}
	r.noBadRequests() // every request signed, every nonce unique, skew within bounds
}

// A grant recalled between step 1 and step 2 stops the job before step 2 runs; the job ends rejected.
func TestRecalledGrantBetweenStepsStopsTheJob(t *testing.T) {
	r := newRig(t, nil)
	r.stub.afterStep = func(_ string, step int) {
		if step == 1 {
			r.fake.RecallGrant()
		}
	}
	r.start(time.Second)
	r.fake.Enqueue("job_recall|steps")
	res, ok := r.fake.WaitResult("job_recall", 5*time.Second)
	if !ok {
		t.Fatal("no result for the recalled job")
	}
	if res.Body["status"] != "rejected" || res.Body["result"].(map[string]any)["reason"] != "grant_not_active" {
		t.Fatalf("a recalled grant must end the job refused: %v", res.Body)
	}
	if got := r.stub.stepsRun("job_recall"); len(got) != 1 || got[0] != 1 {
		t.Fatalf("only step 1 may run once the grant is recalled, ran %v", got)
	}
	if n := r.fake.GrantChecks(); n != 2 {
		t.Fatalf("the grant must be re-checked before each step: %d checks for two steps", n)
	}
	r.noBadRequests()
}

// A live grant lets every step run, with a liveness check before each one.
func TestLiveGrantRunsEveryStepWithACheckBeforeEach(t *testing.T) {
	r := newRig(t, nil)
	r.start(time.Second)
	r.fake.Enqueue("job_live|steps")
	res, ok := r.fake.WaitResult("job_live", 5*time.Second)
	if !ok {
		t.Fatal("no result for the live job")
	}
	if res.Body["status"] != "succeeded" {
		t.Fatalf("a live grant must let the job succeed: %v", res.Body)
	}
	if got := r.stub.stepsRun("job_live"); len(got) != 2 || got[0] != 1 || got[1] != 2 {
		t.Fatalf("every step must run, ran %v", got)
	}
	if n := r.fake.GrantChecks(); n != 2 {
		t.Fatalf("expected a grant check before each of the two steps, got %d", n)
	}
	r.noBadRequests()
}

func TestUnparseableTokensReportNothingAndDoNotStopTheAgent(t *testing.T) {
	r := newRig(t, nil)
	r.start(time.Second)
	r.fake.Enqueue("x|unparseable", "job_after|ok")
	if _, ok := r.fake.WaitResult("job_after", 5*time.Second); !ok {
		t.Fatal("the agent must keep working after a garbage token")
	}
	if n := len(r.fake.Results()); n != 1 {
		t.Fatalf("only the good job may have a result, got %d", n)
	}
}

func TestResultPostingRetriesTransientFailures(t *testing.T) {
	r := newRig(t, nil)
	r.fake.FailResults(2)
	r.start(time.Second)
	r.fake.Enqueue("job_retry|ok")
	if _, ok := r.fake.WaitResult("job_retry", 12*time.Second); !ok {
		t.Fatal("the result must be delivered after transient 503s")
	}
	r.noBadRequests() // each retry used a fresh nonce
}

func TestAlreadySettledResultIsNotRetried(t *testing.T) {
	r := newRig(t, nil)
	r.fake.MarkSettled("job_dup")
	r.start(time.Second)
	r.fake.Enqueue("job_dup|ok", "job_next|ok")
	if _, ok := r.fake.WaitResult("job_next", 5*time.Second); !ok {
		t.Fatal("the agent must carry on after a 409")
	}
	if len(r.fake.ResultsFor("job_dup")) != 0 {
		t.Fatal("the settled job keeps the first writer's result")
	}
}

func TestRevocationViaHeartbeatStopsWorkAndExits3(t *testing.T) {
	r := newRig(t, nil)
	r.start(80 * time.Millisecond)
	r.fake.Enqueue("job_inflight|wait")
	select {
	case <-r.stub.started:
	case <-time.After(5 * time.Second):
		t.Fatal("job did not start")
	}
	r.fake.Revoke()
	if code := r.waitExit(5 * time.Second); code != agent.ExitRevoked {
		t.Fatalf("exit code %d, want %d", code, agent.ExitRevoked)
	}
	close(r.stub.release)
	time.Sleep(300 * time.Millisecond)
	if len(r.fake.Results()) != 0 {
		t.Fatal("a revoked agent must not report further results")
	}
	polls := r.fake.Polls()
	time.Sleep(500 * time.Millisecond)
	if r.fake.Polls() != polls {
		t.Fatal("a revoked agent must not poll again")
	}
}

func TestRevocationOn401AgentRevokedExits3(t *testing.T) {
	r := newRig(t, nil)
	r.fake.RevokeViaPoll()
	r.start(time.Second)
	if code := r.waitExit(5 * time.Second); code != agent.ExitRevoked {
		t.Fatalf("exit code %d", code)
	}
}

func TestUpgradeRequiredExits4(t *testing.T) {
	r := newRig(t, nil)
	r.fake.UpgradeRequired()
	r.start(time.Second)
	if code := r.waitExit(5 * time.Second); code != agent.ExitUpgradeRequired {
		t.Fatalf("exit code %d", code)
	}
}

func TestGracefulShutdownLetsInflightJobsFinish(t *testing.T) {
	r := newRig(t, nil)
	r.start(time.Second)
	r.fake.Enqueue("job_drain|sleep700")
	<-r.stub.started
	r.cancel() // SIGTERM equivalent
	if code := r.waitExit(10 * time.Second); code != agent.ExitOK {
		t.Fatalf("exit code %d", code)
	}
	res, ok := r.fake.WaitResult("job_drain", time.Second)
	if !ok || res.Body["status"] != "succeeded" {
		t.Fatalf("the in-flight job must finish and report before exit: %v", res.Body)
	}
}

func TestShutdownGraceExpiryCancelsJobsAndStillReports(t *testing.T) {
	r := newRig(t, func(c *agent.Common) { c.ShutdownGraceSec = 1 })
	r.start(time.Second)
	r.fake.Enqueue("job_stuck|sleep60000")
	<-r.stub.started
	start := time.Now()
	r.cancel()
	if code := r.waitExit(15 * time.Second); code != agent.ExitOK {
		t.Fatalf("exit code %d", code)
	}
	if time.Since(start) > 10*time.Second {
		t.Fatalf("shutdown took %s", time.Since(start))
	}
	res, ok := r.fake.WaitResult("job_stuck", time.Second)
	if !ok || res.Body["status"] != "failed" {
		t.Fatalf("a job cancelled at the grace deadline should report failed: %v", res.Body)
	}
}

func TestPanickingJobIsContained(t *testing.T) {
	r := newRig(t, nil)
	r.start(time.Second)
	r.fake.Enqueue("job_panic|panic", "job_ok|ok")
	res, ok := r.fake.WaitResult("job_panic", 5*time.Second)
	if !ok || res.Body["status"] != "failed" {
		t.Fatalf("%v", res.Body)
	}
	if strings.Contains(fmt.Sprint(res.Body), inertAccessKey()) {
		t.Fatal("a panic message must not be echoed to the control plane")
	}
	if _, ok := r.fake.WaitResult("job_ok", 5*time.Second); !ok {
		t.Fatal("the agent must survive a panicking job")
	}
}

func TestConcurrencyIsBounded(t *testing.T) {
	r := newRig(t, func(c *agent.Common) { c.MaxConcurrent = 2 })
	r.start(time.Second)
	for i := 0; i < 6; i++ {
		r.fake.Enqueue(fmt.Sprintf("job_c%d|sleep150", i))
	}
	for i := 0; i < 6; i++ {
		if _, ok := r.fake.WaitResult(fmt.Sprintf("job_c%d", i), 10*time.Second); !ok {
			t.Fatalf("job %d never finished", i)
		}
	}
	if m := r.stub.maxRunning.Load(); m > 2 || m < 2 {
		t.Fatalf("max concurrent jobs was %d, want exactly the configured 2", m)
	}
}

func TestOversizedResultIsReplacedByAFailure(t *testing.T) {
	r := newRig(t, nil)
	r.start(time.Second)
	r.fake.Enqueue("job_big|bigresult")
	res, ok := r.fake.WaitResult("job_big", 5*time.Second)
	if !ok || res.Body["status"] != "failed" || !strings.Contains(res.Body["error"].(string), "result_too_large") || res.Body["result"] != nil {
		t.Fatalf("%v", res.Body)
	}
}

func TestPollErrorsBackOffAndRecover(t *testing.T) {
	r := newRig(t, nil)
	r.fake.FailPolls(2)
	r.start(time.Second)
	r.fake.Enqueue("job_after_outage|ok")
	if _, ok := r.fake.WaitResult("job_after_outage", 12*time.Second); !ok {
		t.Fatal("the agent must resume after transient poll failures")
	}
}

func TestLogStreamingIsBatchedOrderedAndRedacted(t *testing.T) {
	r := newRig(t, nil)
	r.start(time.Second)
	r.fake.Enqueue("job_logs|logs")
	if _, ok := r.fake.WaitResult("job_logs", 5*time.Second); !ok {
		t.Fatal("no result")
	}
	logs := r.fake.Logs()
	if len(logs) == 0 {
		t.Fatal("log lines must be streamed")
	}
	var all []string
	lastSeq := 0
	for _, l := range logs {
		if l.JTI != "job_logs" || l.Seq <= lastSeq {
			t.Fatalf("seq must increase per job: %+v", l)
		}
		lastSeq = l.Seq
		for _, line := range l.Lines {
			all = append(all, line["stream"].(string)+": "+line["line"].(string))
			if line["ts"] == nil {
				t.Fatal("lines carry timestamps")
			}
		}
	}
	joined := strings.Join(all, "\n")
	for _, secret := range []string{inertSecretKey(), inertAccessKey(), inertPrivateBody()[:32]} {
		if strings.Contains(joined, secret) {
			t.Fatal("secret leaked to the log stream")
		}
	}
	if !strings.Contains(joined, "stdout: starting up") || !strings.Contains(joined, "stdout: done") || !strings.Contains(joined, "REDACTED") {
		t.Fatalf("%s", joined)
	}
	r.noBadRequests()
}

func TestNextKeysArePinnedAndPersisted(t *testing.T) {
	r := newRig(t, nil)
	newCP := protocolTestKey(t)
	r.fake.AnnounceKeys(newCP)
	r.start(80 * time.Millisecond)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && r.keys.Len() < 2 {
		time.Sleep(20 * time.Millisecond)
	}
	if r.keys.Len() != 2 {
		t.Fatal("the announced key must be pinned")
	}
	saved, err := agent.LoadIdentity(r.cfg.StateDir, agent.RunnerKind)
	if err != nil {
		t.Fatal(err)
	}
	if len(saved.ControlPlaneKeys) != 2 {
		t.Fatalf("pinned keys must be persisted for the next start: %v", saved.ControlPlaneKeys)
	}
}

func protocolTestKey(t *testing.T) protocol.KeyEntry {
	t.Helper()
	pub, _, err := agent.GenerateKey()
	if err != nil {
		t.Fatal("could not generate inert rotation fixture key")
	}
	return protocol.KeyEntry{Kid: "cp-next", PublicKey: protocol.B64Encode(pub)}
}

func TestRegistrationRequestHasNoPrivateMaterial(t *testing.T) {
	r := newRig(t, nil)
	raw, _ := json.Marshal(r.fake.Register)
	if strings.Contains(string(raw), r.id.PrivateKey) || strings.Contains(string(raw), "privateKey") {
		t.Fatal("the private key must never be sent")
	}
	if r.fake.Register["publicKey"] != r.id.PublicKey || r.fake.Register["name"] != "test-runner" {
		t.Fatalf("%v", r.fake.Register)
	}
}

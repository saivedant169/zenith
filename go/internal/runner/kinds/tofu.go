package kinds

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/agent"
	"github.com/GODOSTROYER/zenith/go/internal/proc"
	"github.com/GODOSTROYER/zenith/go/internal/protocol"
	"github.com/GODOSTROYER/zenith/go/internal/redact"
)

// TofuVersion is the OpenTofu version the platform pins (src/lib/tofu/types.ts
// TOFU_VERSION). The runner refuses to run any other version.
const TofuVersion = "1.12.5"

// TofuConfig configures the tofu.run kind.
type TofuConfig struct {
	Toggle
	// Binary is the absolute path of the pinned OpenTofu binary.
	Binary string `json:"binary"`
	// Version is the exact version `tofu version -json` must report
	// (default TofuVersion). Changing it is a deliberate local override.
	Version string `json:"version"`
	// WorkDir is the parent of the fresh per-job directories (default the
	// system temp dir). Every job gets a new 0700 directory that is removed
	// afterwards; nothing is shared between jobs except the plan store and the
	// optional provider cache.
	WorkDir string `json:"workDir"`
	// PluginCacheDir is an optional persistent provider cache. Providers are
	// still verified against the pinned lockfile (-lockfile=readonly).
	PluginCacheDir string `json:"pluginCacheDir"`
	// CLIConfigFile is an optional TF_CLI_CONFIG_FILE (provider mirror).
	CLIConfigFile string `json:"cliConfigFile"`
	// PassEnv lists environment variable NAMES copied from the runner's own
	// environment to tofu, in addition to the built-in cloud-credential
	// variables. Nothing else from the runner's environment reaches tofu, and
	// ZENITH_* names are refused.
	PassEnv []string `json:"passEnv"`
	// PlanMaxAgeSec is how long a retained plan file can be shown or applied
	// (default and maximum 86400: plans are retained at most 24 h).
	PlanMaxAgeSec int `json:"planMaxAgeSec"`
	// AllowUnsafeConfig accepts HCL files and lifts the structural guard
	// (provisioners, external/http/local providers, remote modules).
	AllowUnsafeConfig bool `json:"allowUnsafeConfig"`
	// AllowEphemeralState permits `apply` for a workspace with no remote
	// backend. The state then lives in the job's temp dir and is DESTROYED when
	// the job ends. Only for tests and throwaway environments.
	AllowEphemeralState bool `json:"allowEphemeralState"`
	// MaxConcurrent bounds simultaneous tofu jobs (default 1).
	MaxConcurrent int `json:"maxConcurrent"`
	// MaxPlanJSONBytes bounds the `show -json` document returned (default 3 MiB).
	// It is never truncated: an over-limit plan fails the job.
	MaxPlanJSONBytes int64 `json:"maxPlanJsonBytes"`
	MaxFiles         int   `json:"maxFiles"`
	MaxTotalBytes    int64 `json:"maxTotalBytes"`
	// PlanCapabilities and ApplyCapabilities name the grant capabilities that
	// may run plan/show and apply. Defaults follow the platform catalog.
	PlanCapabilities  []string `json:"planCapabilities"`
	ApplyCapabilities []string `json:"applyCapabilities"`
}

// Default capability sets.
var (
	defaultApplyCaps = []string{"infrastructure.apply", "infrastructure.destroy", "drift.repair", "deployment.deploy", "deployment.rollback"}
	defaultPlanCaps  = []string{"infrastructure.plan", "infrastructure.observe", "cost.estimate"}
)

// builtinPassEnv are the variables that carry the customer's LOCAL cloud
// identity to providers (they are the same ones the aws.http chain reads),
// plus proxy and CA settings.
var builtinPassEnv = []string{
	"AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_REGION", "AWS_DEFAULT_REGION",
	"AWS_ROLE_ARN", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_ROLE_SESSION_NAME", "AWS_STS_REGIONAL_ENDPOINTS",
	"AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	"AWS_CONTAINER_AUTHORIZATION_TOKEN", "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
	"AWS_EC2_METADATA_DISABLED", "AWS_EC2_METADATA_SERVICE_ENDPOINT", "AWS_CA_BUNDLE",
	"KUBERNETES_SERVICE_HOST", "KUBERNETES_SERVICE_PORT",
	"HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy",
	"SSL_CERT_FILE", "SSL_CERT_DIR", "LANG", "LC_ALL",
}

var envNameRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,127}$`)

// Tofu is the tofu.run kind.
type Tofu struct {
	cfg      TofuConfig
	plans    *planStore
	sem      chan struct{}
	getenv   func(string) string
	now      func() time.Time
	applyCap map[string]bool
	planCap  map[string]bool
	locks    keyedLock
}

// TofuDeps are injectable collaborators (tests).
type TofuDeps struct {
	Getenv func(string) string
	Now    func() time.Time
}

// NewTofu validates the config and prepares the plan store under stateDir.
func NewTofu(cfg TofuConfig, stateDir string, deps TofuDeps) (*Tofu, error) {
	if cfg.Binary == "" {
		cfg.Binary = "/usr/local/bin/tofu"
	}
	if !filepath.IsAbs(cfg.Binary) {
		return nil, errors.New("tofu.run binary must be an absolute path")
	}
	if cfg.Version == "" {
		cfg.Version = TofuVersion
	}
	if cfg.WorkDir != "" && !filepath.IsAbs(cfg.WorkDir) {
		return nil, errors.New("tofu.run workDir must be an absolute path")
	}
	if cfg.PlanMaxAgeSec == 0 {
		cfg.PlanMaxAgeSec = 24 * 3600
	}
	if cfg.PlanMaxAgeSec < 60 || cfg.PlanMaxAgeSec > 24*3600 {
		return nil, errors.New("tofu.run planMaxAgeSec must be between 60 and 86400")
	}
	if cfg.MaxConcurrent <= 0 {
		cfg.MaxConcurrent = 1
	}
	if cfg.MaxPlanJSONBytes <= 0 {
		cfg.MaxPlanJSONBytes = 3 << 20
	}
	if cfg.MaxFiles <= 0 {
		cfg.MaxFiles = 512
	}
	if cfg.MaxTotalBytes <= 0 {
		cfg.MaxTotalBytes = 32 << 20
	}
	if len(cfg.ApplyCapabilities) == 0 {
		cfg.ApplyCapabilities = defaultApplyCaps
	}
	if len(cfg.PlanCapabilities) == 0 {
		cfg.PlanCapabilities = defaultPlanCaps
	}
	for _, n := range cfg.PassEnv {
		if !envNameRe.MatchString(n) || strings.HasPrefix(strings.ToUpper(n), "ZENITH_") {
			return nil, fmt.Errorf("tofu.run passEnv entry %q is invalid (ZENITH_* variables are never passed to tofu)", clip(n, 40))
		}
	}
	if st, err := os.Stat(cfg.Binary); err != nil || st.IsDir() {
		return nil, fmt.Errorf("tofu.run binary %s is not usable: %v", cfg.Binary, err)
	}
	if deps.Getenv == nil {
		deps.Getenv = os.Getenv
	}
	if deps.Now == nil {
		deps.Now = time.Now
	}
	plans, err := newPlanStore(filepath.Join(stateDir, "tofu-plans"), deps.Now)
	if err != nil {
		return nil, err
	}
	_ = plans.Prune(time.Duration(cfg.PlanMaxAgeSec) * time.Second)
	t := &Tofu{cfg: cfg, plans: plans, sem: make(chan struct{}, cfg.MaxConcurrent), getenv: deps.Getenv, now: deps.Now,
		applyCap: toSet(cfg.ApplyCapabilities), planCap: toSet(cfg.PlanCapabilities)}
	return t, nil
}

func toSet(ss []string) map[string]bool {
	m := make(map[string]bool, len(ss))
	for _, s := range ss {
		m[s] = true
	}
	return m
}

// Name implements Kind.
func (*Tofu) Name() string { return KindTofuRun }

type tofuFile struct {
	Path       string `json:"path"`
	ContentB64 string `json:"contentB64"`
}

type tofuPayload struct {
	Command      string     `json:"command"`
	Files        []tofuFile `json:"files"`
	Lockfile     string     `json:"lockfile"`
	ConfigDigest string     `json:"configDigest"`
	// PlanFileSha256 names the retained plan file (sha256 hex of its bytes, as
	// returned by `plan`) that `apply` applies and `show` inspects.
	PlanFileSha256 string `json:"planFileSha256"`
	// Destroy (extension, optional) makes `plan` produce a destroy plan.
	Destroy bool `json:"destroy"`
}

var digestRe = regexp.MustCompile(`^[0-9a-f]{64}$`)

type tofuJob struct {
	pl       tofuPayload
	files    []ConfigFile
	facts    configFacts
	lockfile string
	req      *Request
}

// Prepare implements Kind: everything that can be decided before running
// anything, including the configDigest recomputation.
func (t *Tofu) Prepare(req *Request) (Runnable, error) {
	var pl tofuPayload
	if err := decodeStrict(req.Payload, &pl); err != nil {
		return nil, err
	}
	switch pl.Command {
	case "plan", "show":
		if !t.planCap[req.Capability] && !t.applyCap[req.Capability] {
			return nil, notAllowed("capability %q may not run tofu %s on this runner", req.Capability, pl.Command)
		}
	case "apply":
		if !t.applyCap[req.Capability] {
			return nil, notAllowed("capability %q may not run tofu apply on this runner", req.Capability)
		}
	default:
		return nil, invalid("command must be plan, apply or show")
	}
	if pl.Destroy && pl.Command != "plan" {
		return nil, invalid("destroy is only valid with command plan")
	}
	if !digestRe.MatchString(pl.ConfigDigest) {
		return nil, invalid("configDigest must be 64 lowercase hex characters")
	}
	switch pl.Command {
	case "apply", "show":
		if !digestRe.MatchString(pl.PlanFileSha256) {
			return nil, invalid("%s requires planFileSha256 (64 lowercase hex characters)", pl.Command)
		}
	default:
		if pl.PlanFileSha256 != "" {
			return nil, invalid("planFileSha256 is only valid with apply and show")
		}
	}
	if len(pl.Lockfile) > 1<<20 {
		return nil, invalid("lockfile is larger than 1 MiB")
	}
	if len(pl.Files) == 0 || len(pl.Files) > t.cfg.MaxFiles {
		return nil, invalid("files must contain between 1 and %d entries", t.cfg.MaxFiles)
	}
	files := make([]ConfigFile, 0, len(pl.Files))
	seen := map[string]bool{}
	var total int64
	for _, f := range pl.Files {
		if err := ValidateFilePath(f.Path, t.cfg.AllowUnsafeConfig); err != nil {
			return nil, invalid("%v", err)
		}
		if seen[f.Path] {
			return nil, invalid("duplicate file path %q", clip(f.Path, 60))
		}
		seen[f.Path] = true
		content, err := base64.StdEncoding.DecodeString(f.ContentB64)
		if err != nil {
			return nil, invalid("file %q is not valid base64", clip(f.Path, 60))
		}
		total += int64(len(content))
		if total > t.cfg.MaxTotalBytes {
			return nil, invalid("the workspace files exceed %d bytes", t.cfg.MaxTotalBytes)
		}
		files = append(files, ConfigFile{Path: f.Path, Content: content})
	}
	for p := range seen { // a file and a directory of the same name cannot coexist
		for q := range seen {
			if p != q && strings.HasPrefix(q, p+"/") {
				return nil, invalid("file path %q is also used as a directory", clip(p, 60))
			}
		}
	}
	if got := ConfigDigest(files); got != pl.ConfigDigest {
		return nil, protocol.Errorf(protocol.CodeInvalidPayload, "configDigest mismatch: the files hash to %s but the job claims %s", got[:12], pl.ConfigDigest[:12])
	}
	var facts configFacts
	if !t.cfg.AllowUnsafeConfig {
		var err error
		facts, err = GuardConfig(files)
		if err != nil {
			return nil, notAllowed("%v", err)
		}
	}
	if pl.Command == "apply" && !t.cfg.AllowEphemeralState && !t.cfg.AllowUnsafeConfig {
		if facts.Backend == "" || facts.Backend == "local" {
			return nil, notAllowed("apply requires a remote state backend (s3, http, ...): the runner keeps no state between jobs, so a local backend would lose it")
		}
	}
	job := &tofuJob{pl: pl, files: files, facts: facts, lockfile: pl.Lockfile, req: req}
	return func(ctx context.Context, logs agent.LogSink) Outcome { return t.execute(ctx, job, logs) }, nil
}

/* -------------------------------- execution -------------------------------- */

func (t *Tofu) execute(ctx context.Context, j *tofuJob, logs agent.LogSink) Outcome {
	select {
	case t.sem <- struct{}{}:
		defer func() { <-t.sem }()
	case <-ctx.Done():
		o, _ := ctxOutcome(ctx)
		return o
	}
	unlock := t.locks.Lock(j.pl.ConfigDigest)
	defer unlock()
	started := time.Now()
	fail := func(exit int, out *collector, format string, args ...any) Outcome {
		o := Outcome{Status: agent.StatusFailed, Error: fmt.Sprintf(format, args...)}
		if out != nil {
			o.ExitCode = intPtr(exit)
			o.Result = t.resultBody(j, exit, out, nil, started)
		}
		return o
	}

	if o, stop := refusedStep(ctx); stop {
		return o
	}
	if err := t.checkVersion(ctx); err != nil {
		if o, done := ctxOutcome(ctx); done {
			return o
		}
		return failed("%v", err)
	}

	var stored *planMeta
	var planPath string
	if j.pl.Command != "plan" {
		var err error
		stored, planPath, err = t.plans.Get(j.pl.ConfigDigest, j.pl.PlanFileSha256, time.Duration(t.cfg.PlanMaxAgeSec)*time.Second)
		if err != nil {
			return reject("plan_not_found", "%v", err)
		}
		if stored.LockDigest != LockDigest(j.lockfile) {
			return reject("lockfile_mismatch", "the lockfile differs from the one the plan was created with")
		}
		if j.pl.Command == "apply" {
			if stored.Destroy && j.req.Capability != "infrastructure.destroy" {
				return reject("capability_mismatch", "the stored plan destroys infrastructure and needs the infrastructure.destroy capability")
			}
		}
	}

	dir, err := os.MkdirTemp(t.cfg.WorkDir, "zenith-tofu-")
	if err != nil {
		return failed("could not create a working directory: %v", err)
	}
	defer os.RemoveAll(dir)
	if err := os.Chmod(dir, 0o700); err != nil {
		return failed("could not secure the working directory")
	}
	if err := writeWorkspace(dir, j.files, j.lockfile); err != nil {
		return failed("could not write the workspace: %v", err)
	}
	env, cleanupTemp, err := t.buildEnv(dir)
	if err != nil {
		return failed("%v", err)
	}
	defer cleanupTemp()

	out := newCollector(j.req.MaxOutputBytes)
	planFile := filepath.Join(dir, "zenith.tfplan")
	if stored != nil {
		if err := copyFile(planPath, planFile); err != nil {
			return failed("could not stage the saved plan: %v", err)
		}
	}

	if o, stop := refusedStep(ctx); stop {
		return o
	}
	logs.Line("info", "tofu init")
	if code, _, err := t.exec(ctx, dir, env, []string{"init", "-input=false", "-no-color", "-lockfile=readonly"}, out, logs, false); err != nil || code != 0 {
		if o, done := ctxOutcome(ctx); done {
			return o
		}
		return fail(code, out, "tofu init failed (exit %d)", code)
	}

	switch j.pl.Command {
	case "plan":
		args := []string{"plan", "-input=false", "-no-color", "-lock-timeout=60s", "-out=" + planFile}
		if j.pl.Destroy {
			args = append(args, "-destroy")
		}
		if o, stop := refusedStep(ctx); stop {
			return o
		}
		logs.Line("info", "tofu plan")
		code, _, err := t.exec(ctx, dir, env, args, out, logs, false)
		if err != nil || code != 0 {
			if o, done := ctxOutcome(ctx); done {
				return o
			}
			return fail(code, out, "tofu plan failed (exit %d)", code)
		}
		if o, stop := refusedStep(ctx); stop {
			return o
		}
		planJSON, code, err := t.showJSON(ctx, dir, env, planFile, out, logs)
		if err != nil {
			if o, done := ctxOutcome(ctx); done {
				return o
			}
			return fail(code, out, "%v", err)
		}
		planSHA, err := t.plans.Put(planMeta{
			ConfigDigest: j.pl.ConfigDigest, LockDigest: LockDigest(j.lockfile), TofuVersion: t.cfg.Version,
			Destroy: j.pl.Destroy, CreatedAt: t.now().UTC(), JobID: j.req.JTI,
		}, planFile)
		if err != nil {
			return failed("could not retain the plan file for a later apply: %v", err)
		}
		res := t.resultBody(j, 0, out, planJSON, started)
		res["planFileSha256"] = planSHA
		return Outcome{Status: agent.StatusSucceeded, ExitCode: intPtr(0), Result: res}

	case "show":
		if o, stop := refusedStep(ctx); stop {
			return o
		}
		logs.Line("info", "tofu show")
		planJSON, code, err := t.showJSON(ctx, dir, env, planFile, out, logs)
		if err != nil {
			if o, done := ctxOutcome(ctx); done {
				return o
			}
			return fail(code, out, "%v", err)
		}
		res := t.resultBody(j, 0, out, planJSON, started)
		res["planFileSha256"] = j.pl.PlanFileSha256
		return Outcome{Status: agent.StatusSucceeded, ExitCode: intPtr(0), Result: res}

	default: // apply
		if o, stop := refusedStep(ctx); stop {
			return o
		}
		logs.Line("info", "tofu apply")
		// The plan is single-use: whatever happens next, it must not be applied again.
		defer t.plans.Consume(j.pl.ConfigDigest, j.pl.PlanFileSha256)
		code, _, err := t.exec(ctx, dir, env, []string{"apply", "-input=false", "-no-color", "-lock-timeout=60s", planFile}, out, logs, false)
		if err != nil || code != 0 {
			if o, done := ctxOutcome(ctx); done {
				o.ExitCode = intPtr(code)
				o.Result = t.resultBody(j, code, out, nil, started)
				return o
			}
			return fail(code, out, "tofu apply failed (exit %d)", code)
		}
		return Outcome{Status: agent.StatusSucceeded, ExitCode: intPtr(0), Result: t.resultBody(j, 0, out, nil, started)}
	}
}

// refusedStep ends the job before a step whose grant is no longer live (recalled
// between steps, or not confirmable). Nothing of the step has run when it returns true.
func refusedStep(ctx context.Context) (Outcome, bool) {
	err := agent.CheckStep(ctx)
	if err == nil {
		return Outcome{}, false
	}
	code := "grant_unverified"
	if errors.Is(err, agent.ErrGrantNotLive) {
		code = "grant_not_active"
	}
	return reject(code, "the remaining steps were not run: %v", err), true
}

func reject(code, format string, args ...any) Outcome {
	return Outcome{Status: agent.StatusRejected, Error: code + ": " + fmt.Sprintf(format, args...), Result: map[string]any{"reason": code}}
}

func (t *Tofu) resultBody(j *tofuJob, exit int, out *collector, planJSON []byte, started time.Time) map[string]any {
	res := map[string]any{
		"command":    j.pl.Command,
		"exitCode":   exit,
		"output":     out.String(),
		"truncated":  out.Truncated(),
		"durationMs": time.Since(started).Milliseconds(),
	}
	if planJSON != nil {
		res["planJson"] = json.RawMessage(planJSON)
	}
	return res
}

// checkVersion runs `tofu version -json` and requires the pinned version.
func (t *Tofu) checkVersion(ctx context.Context) error {
	tmp, err := os.MkdirTemp(t.cfg.WorkDir, "zenith-tofu-ver-")
	if err != nil {
		return fmt.Errorf("could not create a working directory: %v", err)
	}
	defer os.RemoveAll(tmp)
	env, cleanupTemp, err := t.buildEnv(tmp)
	if err != nil {
		return err
	}
	defer cleanupTemp()
	var stdout bytes.Buffer
	c := newCollector(4096)
	code, raw, err := t.exec(ctx, tmp, env, []string{"version", "-json"}, c, agent.DiscardSink{}, true)
	stdout.Write(raw)
	if err != nil || code != 0 {
		return fmt.Errorf("tofu_unusable: `tofu version` failed (exit %d)", code)
	}
	var v struct {
		Version string `json:"terraform_version"`
	}
	if json.Unmarshal(stdout.Bytes(), &v) != nil || v.Version == "" {
		return errors.New("tofu_unusable: could not parse `tofu version -json`")
	}
	if v.Version != t.cfg.Version {
		return fmt.Errorf("tofu_version_mismatch: the runner's OpenTofu is %s but %s is pinned", clip(v.Version, 20), t.cfg.Version)
	}
	return nil
}

// showJSON runs `tofu show -json <plan>` and returns the document, refusing
// (never truncating) one above MaxPlanJSONBytes.
func (t *Tofu) showJSON(ctx context.Context, dir string, env []string, planFile string, out *collector, logs agent.LogSink) ([]byte, int, error) {
	code, raw, err := t.exec(ctx, dir, env, []string{"show", "-json", "-no-color", planFile}, out, logs, true)
	if err != nil || code != 0 {
		return nil, code, fmt.Errorf("tofu show failed (exit %d)", code)
	}
	if int64(len(raw)) > t.cfg.MaxPlanJSONBytes {
		return nil, code, fmt.Errorf("plan_json_too_large: the plan JSON is %d bytes, above the %d-byte limit (maxPlanJsonBytes)", len(raw), t.cfg.MaxPlanJSONBytes)
	}
	raw = bytes.TrimSpace(raw)
	if !json.Valid(raw) {
		return nil, code, errors.New("tofu show did not produce valid JSON")
	}
	return raw, code, nil
}

// buildEnv builds the child environment from scratch: fixed variables plus an
// explicit allowlist read from the runner's own environment. The caller must
// clean up the private temporary directory after all child processes finish.
func (t *Tofu) buildEnv(dir string) ([]string, func(), error) {
	home := filepath.Join(dir, ".home")
	if err := os.MkdirAll(home, 0o700); err != nil {
		return nil, nil, fmt.Errorf("could not create the home directory: %v", err)
	}
	// Providers create Unix sockets under TMPDIR. A nested workspace can exceed
	// the OS socket-path limit (104 bytes on macOS, 108 on Linux). MkdirTemp
	// creates an exclusive 0700 directory; never share the public temp root itself.
	tmp, err := os.MkdirTemp("", "zt-")
	if err != nil {
		return nil, nil, fmt.Errorf("could not create the temporary directory: %v", err)
	}
	if runtime.GOOS != "windows" && len(tmp) > 80 {
		if err := os.Remove(tmp); err != nil {
			return nil, nil, fmt.Errorf("could not remove the oversized temporary directory: %v", err)
		}
		tmp, err = os.MkdirTemp("/tmp", "zt-")
		if err != nil {
			return nil, nil, fmt.Errorf("could not create a short temporary directory: %v", err)
		}
	}
	cleanup := func() { _ = os.RemoveAll(tmp) }
	env := []string{
		"PATH=/usr/local/bin:/usr/bin:/bin",
		"HOME=" + home,
		"TMPDIR=" + tmp,
		"TF_IN_AUTOMATION=1",
		"TF_INPUT=0",
		"CHECKPOINT_DISABLE=1",
		"TF_DATA_DIR=" + filepath.Join(dir, ".terraform"),
	}
	if t.cfg.PluginCacheDir != "" {
		env = append(env, "TF_PLUGIN_CACHE_DIR="+t.cfg.PluginCacheDir)
	}
	if t.cfg.CLIConfigFile != "" {
		env = append(env, "TF_CLI_CONFIG_FILE="+t.cfg.CLIConfigFile)
	}
	seen := map[string]bool{}
	// PassEnv cannot override the fixed isolation and automation settings.
	for _, entry := range env {
		name, _, _ := strings.Cut(entry, "=")
		seen[name] = true
	}
	for _, name := range append(slices.Clone(builtinPassEnv), t.cfg.PassEnv...) {
		if seen[name] {
			continue
		}
		seen[name] = true
		if v := t.getenv(name); v != "" {
			env = append(env, name+"="+v)
		}
	}
	return env, cleanup, nil
}

// exec runs the pinned binary with argv (never a shell). Output lines are
// redacted and streamed to logs and collected (bounded). With captureStdout the
// raw stdout is returned instead of being treated as log text.
func (t *Tofu) exec(ctx context.Context, dir string, env []string, args []string, out *collector, logs agent.LogSink, captureStdout bool) (int, []byte, error) {
	cmd := exec.CommandContext(ctx, t.cfg.Binary, args...)
	cmd.Dir = dir
	cmd.Env = env
	cmd.Stdin = nil
	proc.Prepare(cmd, proc.Interrupt, 30*time.Second)
	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		return -1, nil, err
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		return -1, nil, err
	}
	if err := cmd.Start(); err != nil {
		return -1, nil, fmt.Errorf("could not start tofu: %v", err)
	}
	// Safety net: if the process ignores the graceful interrupt and the pipes stay
	// open, kill the whole group so this call cannot hang.
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
			select {
			case <-done:
			case <-time.After(45 * time.Second):
				proc.KillGroup(cmd)
			}
		case <-done:
		}
	}()
	var wg sync.WaitGroup
	var captured bytes.Buffer
	wg.Add(2)
	go func() {
		defer wg.Done()
		if captureStdout {
			_, _ = io.Copy(&captured, io.LimitReader(stdoutPipe, t.cfg.MaxPlanJSONBytes+1024))
			_, _ = io.Copy(io.Discard, stdoutPipe)
			return
		}
		pump(stdoutPipe, "stdout", out, logs)
	}()
	go func() {
		defer wg.Done()
		pump(stderrPipe, "stderr", out, logs)
	}()
	wg.Wait()
	werr := cmd.Wait()
	proc.KillGroup(cmd)
	code := 0
	if werr != nil {
		var ee *exec.ExitError
		if errors.As(werr, &ee) {
			code = ee.ExitCode()
			if code == -1 { // killed by signal
				code = 137
			}
			werr = nil
		} else {
			return -1, nil, werr
		}
	}
	return code, captured.Bytes(), werr
}

// pump reads lines, redacts them and forwards them.
func pump(r io.Reader, stream string, out *collector, logs agent.LogSink) {
	var red redact.Lines
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64<<10), 1<<20)
	for sc.Scan() {
		line := red.Line(strings.ToValidUTF8(sc.Text(), "?"))
		out.Add(line)
		logs.Line(stream, line)
	}
	_, _ = io.Copy(io.Discard, r)
}

func writeWorkspace(dir string, files []ConfigFile, lockfile string) error {
	for _, f := range files {
		full := filepath.Join(dir, filepath.FromSlash(f.Path))
		if rel, err := filepath.Rel(dir, full); err != nil || strings.HasPrefix(rel, "..") {
			return fmt.Errorf("path escapes the working directory")
		}
		if err := os.MkdirAll(filepath.Dir(full), 0o700); err != nil {
			return err
		}
		if err := os.WriteFile(full, f.Content, 0o600); err != nil {
			return err
		}
	}
	if lockfile != "" {
		if err := os.WriteFile(filepath.Join(dir, ".terraform.lock.hcl"), []byte(lockfile), 0o600); err != nil {
			return err
		}
	}
	return nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

/* ---------------------------- bounded collector ---------------------------- */

// collector keeps the head and the tail of the output within a byte budget so
// a very chatty apply still shows how it started and how it ended.
type collector struct {
	mu         sync.Mutex
	headBudget int
	tailBudget int
	head       []string
	headBytes  int
	tail       []string
	tailBytes  int
	dropped    int
}

func newCollector(max int64) *collector {
	if max <= 0 {
		max = 1 << 20
	}
	return &collector{headBudget: int(max / 4), tailBudget: int(max - max/4)}
}

func (c *collector) Add(line string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := len(line) + 1
	if c.headBytes+n <= c.headBudget && len(c.tail) == 0 && c.dropped == 0 {
		c.head = append(c.head, line)
		c.headBytes += n
		return
	}
	c.tail = append(c.tail, line)
	c.tailBytes += n
	for c.tailBytes > c.tailBudget && len(c.tail) > 0 {
		c.tailBytes -= len(c.tail[0]) + 1
		c.tail = c.tail[1:]
		c.dropped++
	}
}

func (c *collector) Truncated() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.dropped > 0
}

func (c *collector) String() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	var b strings.Builder
	for _, l := range c.head {
		b.WriteString(l)
		b.WriteByte('\n')
	}
	if c.dropped > 0 {
		fmt.Fprintf(&b, "... [%d lines omitted: output exceeded the limit] ...\n", c.dropped)
	}
	for _, l := range c.tail {
		b.WriteString(l)
		b.WriteByte('\n')
	}
	return b.String()
}

/* ------------------------------- keyed lock -------------------------------- */

type keyedLock struct {
	mu sync.Mutex
	m  map[string]*struct {
		mu sync.Mutex
		n  int
	}
}

// Lock serializes work on one key and returns the unlock function.
func (k *keyedLock) Lock(key string) func() {
	k.mu.Lock()
	if k.m == nil {
		k.m = map[string]*struct {
			mu sync.Mutex
			n  int
		}{}
	}
	e := k.m[key]
	if e == nil {
		e = &struct {
			mu sync.Mutex
			n  int
		}{}
		k.m[key] = e
	}
	e.n++
	k.mu.Unlock()
	e.mu.Lock()
	return func() {
		e.mu.Unlock()
		k.mu.Lock()
		e.n--
		if e.n == 0 {
			delete(k.m, key)
		}
		k.mu.Unlock()
	}
}

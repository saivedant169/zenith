package kinds

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/agent"
)

// runGated runs a job with a step gate on its context, as the agent loop does.
func (h *tofuHarness) runGated(capability string, pl map[string]any, gate func(context.Context) error) Outcome {
	h.t.Helper()
	run, err := h.prepare(capability, pl, 0)
	if err != nil {
		h.t.Fatalf("prepare: %v", err)
	}
	ctx, cancel := context.WithTimeout(agent.WithStepGate(context.Background(), gate), 30*time.Second)
	defer cancel()
	return run(ctx, &memSink{})
}

// gateAllowing returns a step gate that passes its first n checks and refuses every later one.
// A plan job checks before its version probe, init, plan and show.
func gateAllowing(n int) (gate func(context.Context) error, checks *int) {
	count := 0
	return func(context.Context) error {
		count++
		if count > n {
			return agent.ErrGrantNotLive
		}
		return nil
	}, &count
}

func TestTofuGrantRecalledBetweenStepsStopsBeforeTheNextStep(t *testing.T) {
	h := newTofuHarness(t, nil)
	// The version probe and init pass; the check before plan (the next step) finds the grant revoked.
	gate, checks := gateAllowing(2)
	o := h.runGated("infrastructure.plan", payload("plan", basicFiles, nil), gate)
	if o.Status != agent.StatusRejected || !strings.Contains(o.Error, "grant_not_active") {
		t.Fatalf("a grant recalled between steps must end the job refused: %+v", o)
	}
	calls := h.calls()
	if !strings.Contains(calls, "init ") {
		t.Fatalf("step 1 ran before the recall, calls: %q", calls)
	}
	if strings.Contains(calls, "plan ") {
		t.Fatalf("step 2 must never run after the recall, calls: %q", calls)
	}
	if *checks != 3 {
		t.Fatalf("expected the grant checked before the version probe, init and plan, got %d", *checks)
	}
}

func TestTofuLiveGrantRunsEveryStep(t *testing.T) {
	h := newTofuHarness(t, nil)
	gate, checks := gateAllowing(1 << 20)
	o := h.runGated("infrastructure.plan", payload("plan", basicFiles, nil), gate)
	if o.Status != agent.StatusSucceeded {
		t.Fatalf("a live grant must let every step run: %+v", o)
	}
	calls := h.calls()
	for _, step := range []string{"init ", "plan ", "show "} {
		if !strings.Contains(calls, step) {
			t.Fatalf("step %q did not run, calls: %q", step, calls)
		}
	}
	if *checks != 4 {
		t.Fatalf("expected a check before the version probe, init, plan and show, got %d", *checks)
	}
}

func TestTofuRecalledGrantNeverAppliesAndKeepsThePlan(t *testing.T) {
	h := newTofuHarness(t, nil)
	po, _ := h.run("infrastructure.plan", payload("plan", basicFiles, nil))
	if po.Status != agent.StatusSucceeded {
		t.Fatalf("plan: %+v", po)
	}
	planSHA, _ := resultMap(t, po)["planFileSha256"].(string)
	apply := payload("apply", basicFiles, map[string]any{"planFileSha256": planSHA})

	refused := h.runGated("infrastructure.apply", apply, func(context.Context) error { return agent.ErrGrantNotLive })
	if refused.Status != agent.StatusRejected || strings.Contains(h.calls(), "apply ") {
		t.Fatalf("a recalled grant must not apply: status %s, calls %q", refused.Status, h.calls())
	}
	// Nothing ran, so the plan is not spent: a later apply under a live grant still applies it.
	ok := h.runGated("infrastructure.apply", apply, func(context.Context) error { return nil })
	if ok.Status != agent.StatusSucceeded {
		t.Fatalf("the unexecuted plan must still apply under a live grant: %+v", ok)
	}
}

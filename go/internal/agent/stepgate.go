package agent

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/protocol"
)

// ErrGrantNotLive: the control plane no longer holds the job's capability grant live (revoked, expired or unknown).
var ErrGrantNotLive = errors.New("the capability grant for this job is no longer live")

type stepGateKey struct{}

// WithStepGate attaches the grant liveness check the agent runs before each step of a job.
func WithStepGate(ctx context.Context, gate func(context.Context) error) context.Context {
	return context.WithValue(ctx, stepGateKey{}, gate)
}

// CheckStep runs the job's step gate. A multi-step job calls it before every
// step and stops, without running that step, on an error. Without a gate (a job
// run outside the agent loop) it returns nil.
func CheckStep(ctx context.Context) error {
	if gate, ok := ctx.Value(stepGateKey{}).(func(context.Context) error); ok {
		return gate(ctx)
	}
	return nil
}

// grantPath builds the grant liveness endpoint for a job.
func grantPath(kind Kind, agentID, jti string) string {
	return protocol.APIPrefix + "/" + kind.Collection + "/" + agentID + "/jobs/" + jti + "/grant"
}

// checkGrant asks the control plane whether the job's grant is still live. Only
// an explicit 2xx counts as live; a recall (403 grant_not_active) and any
// failure to learn the answer both fail closed.
func (a *Agent) checkGrant(ctx context.Context, jti string) error {
	_, err := a.client.Do(ctx, http.MethodGet, grantPath(a.opts.Kind, a.opts.Identity.ID, jti), nil, nil, 20*time.Second, 1<<10)
	var he *HTTPError
	switch {
	case err == nil:
		return nil
	case errors.Is(err, ErrRevoked):
		a.markRevoked()
		return err
	case errors.As(err, &he) && he.Code == "grant_not_active":
		return ErrGrantNotLive
	default:
		return fmt.Errorf("grant liveness could not be confirmed: %w", err)
	}
}

// Package fakecp is an in-process fake of the Zenith control plane's agent
// endpoints (registration, poll, heartbeat, result, logs). It verifies the
// request signatures exactly as spec section 3 requires, tracks nonces, and
// lets tests queue jobs, revoke the agent and inject failures. Test support
// only; no shipped binary imports it.
package fakecp

import (
	"crypto/ed25519"
	"crypto/tls"
	"encoding/json"
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/GODOSTROYER/zenith/go/internal/protocol"
	"github.com/GODOSTROYER/zenith/go/internal/protocol/protocoltest"
)

// ResultRecord is one result POST.
type ResultRecord struct {
	JTI  string
	Body map[string]any
}

// LogRecord is one logs POST.
type LogRecord struct {
	JTI   string
	Seq   int
	Lines []map[string]any
}

// Server is the fake control plane.
type Server struct {
	*httptest.Server
	CP         *protocoltest.ControlPlane
	Collection string // "runners" or "machines"
	Protocol   string
	Token      string // the single-use registration token
	AgentID    string
	Workspace  string

	mu           sync.Mutex
	agentPub     ed25519.PublicKey
	registered   bool
	tokenUsed    bool
	nonces       map[string]bool
	queue        []string
	results      []ResultRecord
	logs         []LogRecord
	heartbeats   []map[string]any
	polls        int
	bad          []string
	revoked      bool
	revokeOnPoll bool
	recalled     bool // grant liveness checks answer 403 grant_not_active
	grantChecks  int
	upgrade      bool
	nextKeys     []protocol.KeyEntry
	pollFailures int
	resultFail   int
	settled      map[string]bool
	wake         chan struct{}
	t            *testing.T
	// Register is the JSON the agent last sent to /register (token redacted).
	Register map[string]any
}

// New starts a TLS fake control plane for an agent kind.
func New(t *testing.T, collection, protocolID string) *Server {
	t.Helper()
	s := &Server{
		CP: protocoltest.New("cp-e2e"), Collection: collection, Protocol: protocolID,
		Token: "zrt_e2e_registration_token", AgentID: "agt_e2e", Workspace: "ws_e2e",
		nonces: map[string]bool{}, settled: map[string]bool{}, wake: make(chan struct{}, 1), t: t,
	}
	if collection == "runners" {
		s.AgentID = "run_e2e"
	} else {
		s.AgentID = "mac_e2e"
	}
	s.Server = httptest.NewUnstartedServer(http.HandlerFunc(s.handle))
	s.Server.TLS = &tls.Config{MinVersion: tls.VersionTLS12}
	s.Server.StartTLS()
	t.Cleanup(s.Server.Close)
	return s
}

// CAFile writes the server certificate as a PEM CA bundle into dir.
func (s *Server) CAFile(dir string) string {
	p := filepath.Join(dir, "ca.pem")
	if err := os.WriteFile(p, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: s.Certificate().Raw}), 0o600); err != nil {
		s.t.Fatal(err)
	}
	return p
}

// Enqueue queues a compact JWS for the next poll.
func (s *Server) Enqueue(tokens ...string) {
	s.mu.Lock()
	s.queue = append(s.queue, tokens...)
	s.mu.Unlock()
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// Revoke makes heartbeats answer revoked:true.
func (s *Server) Revoke() { s.mu.Lock(); s.revoked = true; s.mu.Unlock() }

// RecallGrant makes grant liveness checks answer 403 grant_not_active from now on.
func (s *Server) RecallGrant() { s.mu.Lock(); s.recalled = true; s.mu.Unlock() }

// GrantChecks returns how many grant liveness checks the agent made.
func (s *Server) GrantChecks() int { s.mu.Lock(); defer s.mu.Unlock(); return s.grantChecks }

// RevokeViaPoll makes the next poll answer 401 agent_revoked.
func (s *Server) RevokeViaPoll() { s.mu.Lock(); s.revokeOnPoll = true; s.mu.Unlock() }

// AnnounceKeys returns nextKeys in heartbeat responses.
func (s *Server) AnnounceKeys(k ...protocol.KeyEntry) { s.mu.Lock(); s.nextKeys = k; s.mu.Unlock() }

// MarkSettled makes result posts for jti answer 409 already_settled.
func (s *Server) MarkSettled(jti string) { s.mu.Lock(); s.settled[jti] = true; s.mu.Unlock() }

// UpgradeRequired makes every poll answer 426 upgrade_required.
func (s *Server) UpgradeRequired() { s.mu.Lock(); s.upgrade = true; s.mu.Unlock() }

// FailPolls makes the next n polls answer 500.
func (s *Server) FailPolls(n int) { s.mu.Lock(); s.pollFailures = n; s.mu.Unlock() }

// FailResults makes the next n result posts answer 503.
func (s *Server) FailResults(n int) { s.mu.Lock(); s.resultFail = n; s.mu.Unlock() }

// Results returns a copy of the recorded results.
func (s *Server) Results() []ResultRecord {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]ResultRecord(nil), s.results...)
}

// ResultsFor returns the results recorded for one job.
func (s *Server) ResultsFor(jti string) []ResultRecord {
	var out []ResultRecord
	for _, r := range s.Results() {
		if r.JTI == jti {
			out = append(out, r)
		}
	}
	return out
}

// Logs returns a copy of the recorded log posts.
func (s *Server) Logs() []LogRecord {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]LogRecord(nil), s.logs...)
}

// Heartbeats returns a copy of the recorded heartbeat bodies.
func (s *Server) Heartbeats() []map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]map[string]any(nil), s.heartbeats...)
}

// Polls returns how many poll requests were served.
func (s *Server) Polls() int { s.mu.Lock(); defer s.mu.Unlock(); return s.polls }

// BadRequests returns descriptions of requests that failed verification.
func (s *Server) BadRequests() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.bad...)
}

// WaitResult waits for a result of the given job.
func (s *Server) WaitResult(jti string, d time.Duration) (ResultRecord, bool) {
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if rs := s.ResultsFor(jti); len(rs) > 0 {
			return rs[0], true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return ResultRecord{}, false
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *Server) handle(w http.ResponseWriter, r *http.Request) {
	base := protocol.APIPrefix + "/" + s.Collection
	body, _ := io.ReadAll(io.LimitReader(r.Body, 64<<20))
	if r.URL.Path == base+"/register" && r.Method == http.MethodPost {
		s.handleRegister(w, body)
		return
	}
	prefix := base + "/" + s.AgentID + "/"
	if !strings.HasPrefix(r.URL.Path, prefix) {
		writeJSON(w, 404, map[string]any{"error": "not_found"})
		return
	}
	s.mu.Lock()
	pub, agentID := s.agentPub, s.AgentID
	s.mu.Unlock()
	if r.Header.Get(protocol.HeaderAgent) != agentID {
		s.recordBad("wrong agent header on " + r.URL.Path)
		writeJSON(w, 401, map[string]any{"error": "unknown_agent"})
		return
	}
	if err := protocol.VerifyRequest(pub, s.Protocol, r.Method, r.URL.RequestURI(), body, r.Header, time.Now()); err != nil {
		s.recordBad(r.URL.Path + ": " + err.Error())
		writeJSON(w, 401, map[string]any{"error": "bad_signature"})
		return
	}
	nonce := r.Header.Get(protocol.HeaderNonce)
	s.mu.Lock()
	if s.nonces[nonce] {
		s.bad = append(s.bad, "nonce replayed on "+r.URL.Path)
		s.mu.Unlock()
		writeJSON(w, 401, map[string]any{"error": "nonce_replayed"})
		return
	}
	s.nonces[nonce] = true
	revoked := s.revoked
	s.mu.Unlock()

	rest := strings.TrimPrefix(r.URL.Path, prefix)
	switch {
	case rest == "poll":
		s.handlePoll(w, body)
	case rest == "heartbeat":
		s.handleHeartbeat(w, body, revoked)
	case strings.HasPrefix(rest, "jobs/") && strings.HasSuffix(rest, "/result"):
		s.handleResult(w, strings.TrimSuffix(strings.TrimPrefix(rest, "jobs/"), "/result"), body)
	case strings.HasPrefix(rest, "jobs/") && strings.HasSuffix(rest, "/logs"):
		s.handleLogs(w, strings.TrimSuffix(strings.TrimPrefix(rest, "jobs/"), "/logs"), body)
	case strings.HasPrefix(rest, "jobs/") && strings.HasSuffix(rest, "/grant") && r.Method == http.MethodGet:
		s.handleGrant(w, strings.TrimSuffix(strings.TrimPrefix(rest, "jobs/"), "/grant"))
	default:
		writeJSON(w, 404, map[string]any{"error": "not_found"})
	}
}

func (s *Server) recordBad(msg string) { s.mu.Lock(); s.bad = append(s.bad, msg); s.mu.Unlock() }

func (s *Server) handleRegister(w http.ResponseWriter, body []byte) {
	var req map[string]any
	if json.Unmarshal(body, &req) != nil {
		writeJSON(w, 400, map[string]any{"error": "bad_request"})
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.tokenUsed || req["token"] != s.Token {
		writeJSON(w, 401, map[string]any{"error": "invalid_registration_token"})
		return
	}
	pubB64, _ := req["publicKey"].(string)
	raw, err := protocol.B64Decode(pubB64)
	if err != nil || len(raw) != ed25519.PublicKeySize {
		writeJSON(w, 400, map[string]any{"error": "bad_public_key"})
		return
	}
	s.tokenUsed = true
	s.agentPub = ed25519.PublicKey(raw)
	s.registered = true
	delete(req, "token")
	s.Register = req
	writeJSON(w, 200, map[string]any{
		"id": s.AgentID, "workspaceId": s.Workspace, "controlPlaneKeys": s.CP.Keys(), "pollIntervalSec": 1, "protocol": s.Protocol,
	})
}

func (s *Server) handlePoll(w http.ResponseWriter, body []byte) {
	var req struct {
		Max     int `json:"max"`
		WaitSec int `json:"waitSec"`
	}
	_ = json.Unmarshal(body, &req)
	s.mu.Lock()
	s.polls++
	if s.revokeOnPoll {
		s.mu.Unlock()
		writeJSON(w, 401, map[string]any{"error": "agent_revoked"})
		return
	}
	if s.upgrade {
		s.mu.Unlock()
		writeJSON(w, 426, map[string]any{"error": "upgrade_required", "minimumProtocol": "zenith.runner/v2"})
		return
	}
	if s.pollFailures > 0 {
		s.pollFailures--
		s.mu.Unlock()
		writeJSON(w, 500, map[string]any{"error": "internal"})
		return
	}
	s.mu.Unlock()
	// short long-poll so tests stay fast
	deadline := time.After(150 * time.Millisecond)
	for {
		s.mu.Lock()
		if len(s.queue) > 0 {
			n := min(max(req.Max, 1), len(s.queue))
			jobs := append([]string(nil), s.queue[:n]...)
			s.queue = s.queue[n:]
			s.mu.Unlock()
			writeJSON(w, 200, map[string]any{"jobs": jobs})
			return
		}
		s.mu.Unlock()
		select {
		case <-s.wake:
		case <-deadline:
			writeJSON(w, 200, map[string]any{"jobs": []string{}})
			return
		}
	}
}

func (s *Server) handleHeartbeat(w http.ResponseWriter, body []byte, revoked bool) {
	var hb map[string]any
	_ = json.Unmarshal(body, &hb)
	s.mu.Lock()
	s.heartbeats = append(s.heartbeats, hb)
	next := s.nextKeys
	s.mu.Unlock()
	resp := map[string]any{"revoked": revoked, "pollIntervalSec": 1}
	if len(next) > 0 {
		resp["nextKeys"] = next
	}
	writeJSON(w, 200, resp)
}

func (s *Server) handleResult(w http.ResponseWriter, jti string, body []byte) {
	var rec map[string]any
	_ = json.Unmarshal(body, &rec)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.resultFail > 0 {
		s.resultFail--
		writeJSON(w, 503, map[string]any{"error": "unavailable"})
		return
	}
	if s.settled[jti] {
		writeJSON(w, 409, map[string]any{"error": "already_settled"})
		return
	}
	s.settled[jti] = true
	s.results = append(s.results, ResultRecord{JTI: jti, Body: rec})
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) handleGrant(w http.ResponseWriter, jti string) {
	s.mu.Lock()
	s.grantChecks++
	recalled := s.recalled
	s.mu.Unlock()
	if recalled {
		writeJSON(w, 403, map[string]any{"error": map[string]any{"code": "grant_not_active", "message": "The capability grant for this job is no longer active."}})
		return
	}
	writeJSON(w, 200, map[string]any{"live": true, "jobId": jti})
}

func (s *Server) handleLogs(w http.ResponseWriter, jti string, body []byte) {
	var rec struct {
		Seq   int              `json:"seq"`
		Lines []map[string]any `json:"lines"`
	}
	_ = json.Unmarshal(body, &rec)
	s.mu.Lock()
	s.logs = append(s.logs, LogRecord{JTI: jti, Seq: rec.Seq, Lines: rec.Lines})
	s.mu.Unlock()
	writeJSON(w, 200, map[string]any{"ok": true})
}

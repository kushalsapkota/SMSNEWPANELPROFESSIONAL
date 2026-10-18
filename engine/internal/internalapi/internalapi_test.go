package internalapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"smsgw/engine/internal/billing"
	"smsgw/engine/internal/dispatch"
	"smsgw/engine/internal/pipeline"
	"smsgw/engine/internal/policy"
	"smsgw/engine/internal/smpp/pdu"
	"smsgw/engine/internal/smpp/server"
	"smsgw/engine/internal/store"
)

const token = "0123456789abcdef-token"

type fakePipeline struct {
	mu   sync.Mutex
	reqs []pipeline.Request
}

func (f *fakePipeline) Submit(_ context.Context, r pipeline.Request) (*pipeline.Result, error) {
	f.mu.Lock()
	f.reqs = append(f.reqs, r)
	f.mu.Unlock()
	switch {
	case strings.HasPrefix(r.Destination, "000"):
		return nil, policy.New(policy.CodeInvalidDestination, "bad destination")
	case r.Text == "boom":
		return nil, fmt.Errorf("redis exploded")
	case r.Text == "poor":
		return nil, policy.New(policy.CodeInsufficientFunds, "insufficient balance")
	}
	return &pipeline.Result{MessageID: "m-" + r.Destination, Status: "ACCEPTED", Parts: 1, Encoding: "GSM7", CostMicros: 5, RouteID: "r", SentText: r.Text}, nil
}

func (f *fakePipeline) Preview(_ context.Context, r pipeline.PreviewRequest) (*pipeline.PreviewResult, error) {
	out := "x"
	return &pipeline.PreviewResult{Action: "SEND_RAW", Output: &out, Encoding: "GSM7", Parts: 1}, nil
}

type fakeConns struct{}

func (fakeConns) Status() []dispatch.ConnStatus {
	return []dispatch.ConnStatus{{ConnectionID: "c1", Name: "up", Enabled: true, State: "BOUND", Sessions: []dispatch.SessionStatus{}, TPSLimit: 10}}
}
func (fakeConns) QueueDepth() int64              { return 7 }
func (fakeConns) ConnectionsUp() (up, total int) { return 1, 2 }

type fakeSMPP struct{ kicked []string }

func (f *fakeSMPP) Sessions() []server.SessionInfo {
	return []server.SessionInfo{{ID: "s1", OrgID: "o1", SystemID: "sys", BindType: pdu.BindTransceiver, RemoteAddr: "1.2.3.4:5", BoundSince: time.Unix(0, 0)}}
}
func (f *fakeSMPP) Kick(org string) int { f.kicked = append(f.kicked, org); return 2 }

type fakeBal struct{ calls []string }

func (f *fakeBal) Credit(_ context.Context, tag, org string, delta int64, key string) (billing.CreditResult, error) {
	f.calls = append(f.calls, fmt.Sprintf("%s|%s|%d|%s", tag, org, delta, key))
	v := int64(100) + delta
	return billing.CreditResult{Status: "OK", Balance: &v}, nil
}

func (f *fakeBal) Balance(_ context.Context, tag, org string) (billing.BalanceInfo, error) {
	if org == noAcct {
		return billing.BalanceInfo{}, fmt.Errorf("%w %s", billing.ErrNoAccount, org)
	}
	return billing.BalanceInfo{Balance: 42, Limit: 10, Loaded: true}, nil
}

type snap struct{ s *store.Snapshot }

func (s snap) Current() *store.Snapshot { return s.s }

var (
	admin, reseller, client, noAcct = uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
)

func newAPI() (*API, *fakePipeline, *fakeSMPP, *fakeBal) {
	p, sm, b := &fakePipeline{}, &fakeSMPP{}, &fakeBal{}
	s := store.NewSnapshot(store.Data{Orgs: []*store.Org{
		{ID: admin, Role: store.RoleSuperAdmin}, {ID: reseller, Role: store.RoleReseller, ParentID: admin},
		{ID: client, Role: store.RoleClient, ParentID: reseller}, {ID: noAcct, Role: store.RoleClient, ParentID: reseller},
	}})
	return New(Deps{Token: token, Pipeline: p, Connections: fakeConns{}, SMPP: sm, Balances: b, Store: snap{s}}), p, sm, b
}

func do(t *testing.T, h http.Handler, method, path, body, tok string) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	if tok != "" {
		req.Header.Set("X-Internal-Token", tok)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("%s %s: non-JSON response %q", method, path, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("content type %q", ct)
	}
	return rec.Code, out
}

func TestAuth(t *testing.T) {
	a, _, _, _ := newAPI()
	for _, tok := range []string{"", "wrong"} {
		st, b := do(t, a, "GET", "/internal/v1/connections/status", "", tok)
		if st != 401 || b["error_code"] != "UNAUTHORIZED" {
			t.Fatalf("%q: %d %v", tok, st, b)
		}
	}
	st, b := do(t, a, "GET", "/internal/v1/nope", "", token)
	if st != 404 || b["error_code"] != "NOT_FOUND" {
		t.Fatalf("%d %v", st, b)
	}
}

func TestSubmit(t *testing.T) {
	a, p, _, _ := newAPI()
	st, b := do(t, a, "POST", "/internal/v1/submit", `{"org_id":"`+client+`","channel":"web","source":"S","destination":"447","text":"hi","client_ref":"c1","route_id":"`+reseller+`","test":true}`, token)
	if st != 200 || b["message_id"] != "m-447" || b["status"] != "ACCEPTED" || b["cost_micros"].(float64) != 5 || b["sent_text"] != "hi" {
		t.Fatalf("%d %v", st, b)
	}
	r := p.reqs[0]
	if r.Channel != "WEB" || r.ClientRef != "c1" || r.RouteID != reseller || !r.Test || r.OrgID != client {
		t.Fatalf("request %+v", r)
	}
	cases := []struct {
		body   string
		status int
		code   string
	}{
		{`{"org_id":"` + client + `","channel":"SMPP","text":"x","destination":"1"}`, 400, "INVALID_REQUEST"},
		{`{"channel":"HTTP"}`, 400, "INVALID_REQUEST"},
		{`not json`, 400, "INVALID_REQUEST"},
		{``, 400, "INVALID_REQUEST"},
		{`{"org_id":"` + client + `","channel":"HTTP","text":"x","destination":"000"}`, 422, "INVALID_DESTINATION"},
		{`{"org_id":"` + client + `","channel":"HTTP","text":"poor","destination":"1"}`, 422, "INSUFFICIENT_FUNDS"},
		{`{"org_id":"` + client + `","channel":"HTTP","text":"boom","destination":"1"}`, 500, "INTERNAL"},
	}
	for _, c := range cases {
		st, b := do(t, a, "POST", "/internal/v1/submit", c.body, token)
		if st != c.status || b["error_code"] != c.code || b["message"] == "" {
			t.Errorf("%s: %d %v", c.body, st, b)
		}
		if c.code == "INTERNAL" && strings.Contains(fmt.Sprint(b["message"]), "redis") {
			t.Errorf("internal cause leaked: %v", b)
		}
	}
}

func TestBatchKeepsOrder(t *testing.T) {
	a, _, _, _ := newAPI()
	var items []string
	for i := 0; i < 50; i++ {
		dest := fmt.Sprintf("44%03d", i)
		if i%7 == 0 {
			dest = "000"
		}
		items = append(items, `{"org_id":"`+client+`","channel":"HTTP","source":"S","destination":"`+dest+`","text":"t"}`)
	}
	items = append(items, `42`)
	st, b := do(t, a, "POST", "/internal/v1/submit/batch", `{"items":[`+strings.Join(items, ",")+`]}`, token)
	if st != 200 {
		t.Fatalf("%d %v", st, b)
	}
	res := b["results"].([]any)
	if len(res) != 51 {
		t.Fatalf("%d results", len(res))
	}
	for i := 0; i < 50; i++ {
		r := res[i].(map[string]any)
		if i%7 == 0 {
			if r["error_code"] != "INVALID_DESTINATION" {
				t.Fatalf("item %d: %v", i, r)
			}
		} else if r["message_id"] != fmt.Sprintf("m-44%03d", i) {
			t.Fatalf("item %d out of order: %v", i, r)
		}
	}
	if res[50].(map[string]any)["error_code"] != "INVALID_REQUEST" {
		t.Fatalf("bad item: %v", res[50])
	}
	if st, b := do(t, a, "POST", "/internal/v1/submit/batch", `{"items":[]}`, token); st != 400 || b["error_code"] != "INVALID_REQUEST" {
		t.Fatalf("empty: %d %v", st, b)
	}
	big := `{"items":[` + strings.TrimSuffix(strings.Repeat(`{},`, 1001), ",") + `]}`
	if st, _ := do(t, a, "POST", "/internal/v1/submit/batch", big, token); st != 400 {
		t.Fatalf("1001 items: %d", st)
	}
}

func TestMonitoringAndKick(t *testing.T) {
	a, _, sm, _ := newAPI()
	st, b := do(t, a, "GET", "/internal/v1/connections/status", "", token)
	c := b["connections"].([]any)[0].(map[string]any)
	if st != 200 || c["connection_id"] != "c1" || c["state"] != "BOUND" || c["tps_limit"].(float64) != 10 {
		t.Fatalf("%d %v", st, b)
	}
	st, b = do(t, a, "GET", "/internal/v1/smpp/sessions", "", token)
	s := b["sessions"].([]any)[0].(map[string]any)
	if st != 200 || s["session_id"] != "s1" || s["bind_type"] != "TRX" || s["remote_addr"] != "1.2.3.4:5" || s["bound_since"] != "1970-01-01T00:00:00Z" {
		t.Fatalf("%d %v", st, b)
	}
	st, b = do(t, a, "POST", "/internal/v1/smpp/sessions/kick", `{"org_id":"`+client+`"}`, token)
	if st != 200 || b["kicked"].(float64) != 2 || sm.kicked[0] != client {
		t.Fatalf("%d %v", st, b)
	}
	if st, _ := do(t, a, "POST", "/internal/v1/smpp/sessions/kick", `{"org_id":"x"}`, token); st != 400 {
		t.Fatal(st)
	}
	st, b = do(t, a, "GET", "/internal/v1/stats", "", token)
	if st != 200 || b["queue_depth"].(float64) != 7 || b["connections_up"].(float64) != 1 || b["connections_total"].(float64) != 2 {
		t.Fatalf("%d %v", st, b)
	}
	if st, b := do(t, a, "POST", "/internal/v1/template/preview", `{"text":"x","route_id":"bad"}`, token); st != 400 {
		t.Fatalf("%d %v", st, b)
	}
	if st, b := do(t, a, "POST", "/internal/v1/template/preview", `{"text":"x"}`, token); st != 200 || b["action"] != "SEND_RAW" || b["template_id"] != nil {
		t.Fatalf("%d %v", st, b)
	}
	// Health without DB/Redis reports false and 503.
	if st, b := do(t, a, "GET", "/internal/v1/health", "", token); st != 503 || b["ok"] != false || b["db"] != false {
		t.Fatalf("%d %v", st, b)
	}
}

func TestBalances(t *testing.T) {
	a, _, _, bal := newAPI()
	st, b := do(t, a, "POST", "/internal/v1/balance/credit", `{"org_id":"`+client+`","delta_micros":-250,"idempotency_key":"k1"}`, token)
	if st != 200 || b["status"] != "OK" || b["balance_micros"].(float64) != -150 || bal.calls[0] != reseller+"|"+client+"|-250|k1" {
		t.Fatalf("%d %v %v", st, b, bal.calls)
	}
	// A reseller's own balance uses its own id as the tag.
	if st, _ := do(t, a, "POST", "/internal/v1/balance/credit", `{"org_id":"`+reseller+`","delta_micros":5,"idempotency_key":"k2"}`, token); st != 200 || !strings.HasPrefix(bal.calls[1], reseller+"|"+reseller) {
		t.Fatalf("%d %v", st, bal.calls)
	}
	for _, body := range []string{
		`{"org_id":"x","delta_micros":1,"idempotency_key":"k"}`,
		`{"org_id":"` + client + `","idempotency_key":"k"}`,
		`{"org_id":"` + client + `","delta_micros":1}`,
		`{"org_id":"` + admin + `","delta_micros":1,"idempotency_key":"k"}`,
	} {
		if st, b := do(t, a, "POST", "/internal/v1/balance/credit", body, token); st != 400 || b["error_code"] != "INVALID_REQUEST" {
			t.Errorf("%s: %d %v", body, st, b)
		}
	}
	st, b = do(t, a, "GET", "/internal/v1/balance/"+client, "", token)
	if st != 200 || b["balance_micros"].(float64) != 42 || b["credit_limit_micros"].(float64) != 10 || b["loaded"] != true {
		t.Fatalf("%d %v", st, b)
	}
	if st, b := do(t, a, "GET", "/internal/v1/balance/"+noAcct, "", token); st != 404 || b["error_code"] != "NOT_FOUND" {
		t.Fatalf("%d %v", st, b)
	}
	if st, b := do(t, a, "GET", "/internal/v1/balance/"+uuid.NewString(), "", token); st != 404 {
		t.Fatalf("unknown org without DB: %d %v", st, b)
	}
}

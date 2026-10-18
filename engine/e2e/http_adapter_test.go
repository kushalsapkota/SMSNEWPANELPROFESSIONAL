package e2e

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
)

// fakeNPProvider serves three Nepal provider APIs on one server:
// MessengerNepal under /mn (callback DLR), Twozero under /tz (poll DLR) and
// Sparrow under /sp (no DLR).
type fakeNPProvider struct {
	srv    *httptest.Server
	n      atomic.Int64
	mu     sync.Mutex
	tokens []string
}

func newFakeNPProvider(t *testing.T) *fakeNPProvider {
	f := &fakeNPProvider{}
	f.srv = httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		f.n.Add(1)
		rw.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/mn/sms/send":
			f.note(r.Header.Get("X-API-Key"))
			rw.WriteHeader(202)
			io.WriteString(rw, `{"success":true,"message":"SMS accepted for delivery","data":{"message_id":"mn-`+uuid.NewString()[:8]+`","status":"accepted"}}`)
		case r.URL.Path == "/tz/sms/send":
			f.note(r.Header.Get("X-API-Key"))
			io.WriteString(rw, `{"status":"success","message":"SMS sent successfully","data":{"message_id":"tz-`+randHex(6)+`","status":"sent"}}`)
		case strings.HasPrefix(r.URL.Path, "/tz/sms/status/"):
			io.WriteString(rw, `{"status":"success","data":{"status":"delivered","delivery_report":{"status":"delivered"}}}`)
		case r.URL.Path == "/sp/sms/":
			v, _ := url.ParseQuery(string(b))
			f.note(v.Get("token"))
			io.WriteString(rw, `{"count":1,"response_code":200,"response":"1 mesages has been queued for delivery"}`)
		default:
			rw.WriteHeader(404)
			io.WriteString(rw, `{"success":false,"error":"not found"}`)
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeNPProvider) note(tok string) {
	f.mu.Lock()
	f.tokens = append(f.tokens, tok)
	f.mu.Unlock()
}

// HTTP adapter connections end to end: routing to provider APIs, callback
// and poll DLRs updating the CDR and reaching the client webhook, NODLR
// messages staying SUBMITTED without refund, status / test-send / catalogue.
func TestHTTPAdapterConnections(t *testing.T) {
	dumpLogsOnFailure(t)
	ctx := context.Background()
	prov := newFakeNPProvider(t)
	const secret = "e2e-provider-SECRET-key"
	enc, _ := w.cipher.EncryptString(`{"token":"` + secret + `"}`)
	cb, poll, nodlr := uuid.NewString(), uuid.NewString(), uuid.NewString()
	rCB, rPoll, rNoDLR := uuid.NewString(), uuid.NewString(), uuid.NewString()
	dlrToken := "dlr_" + randHex(40)
	sfx := randHex(6)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := w.pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
	exec(`INSERT INTO upstream_connections (id, name, kind, adapter, http_credentials_enc, http_settings, dlr_token, max_tps)
	      VALUES ($1, $2, 'HTTP', 'messengernepal', $3, $4, $5, 50)`, cb, "mn-"+sfx, enc, `{"base_url":"`+prov.srv.URL+`/mn"}`, dlrToken)
	exec(`INSERT INTO upstream_connections (id, name, kind, adapter, http_credentials_enc, http_settings, max_tps)
	      VALUES ($1, $2, 'HTTP', 'twozero', $3, $4, 50)`, poll, "tz-"+sfx, enc, `{"base_url":"`+prov.srv.URL+`/tz","max_concurrency":3}`)
	exec(`INSERT INTO upstream_connections (id, name, kind, adapter, http_credentials_enc, http_settings, max_tps)
	      VALUES ($1, $2, 'HTTP', 'sparrow_v2', $3, $4, 50)`, nodlr, "sp-"+sfx, enc, `{"base_url":"`+prov.srv.URL+`/sp","sender":"ALERT"}`)
	exec(`INSERT INTO upstream_rates (connection_id, prefix, cost_micros, effective_from) VALUES ($1, '977', 300, now() - interval '1 day')`, cb)
	for i, r := range []struct{ route, conn string }{{rCB, cb}, {rPoll, poll}, {rNoDLR, nodlr}} {
		exec(`INSERT INTO routes (id, name) VALUES ($1, $2)`, r.route, "np"+string(rune('a'+i))+"-"+sfx)
		exec(`INSERT INTO route_connections (route_id, connection_id, priority) VALUES ($1, $2, 1)`, r.route, r.conn)
		exec(`INSERT INTO org_route_assignments (org_id, route_id, prefix, rate_micros) VALUES ($1, $2, '977', 1000)`, w.ids.reseller, r.route)
		exec(`INSERT INTO org_route_assignments (org_id, route_id, prefix, rate_micros) VALUES ($1, $2, '977', 2000)`, w.ids.client, r.route)
	}
	t.Cleanup(func() {
		ctx := context.Background()
		routes := []string{rCB, rPoll, rNoDLR}
		w.pool.Exec(ctx, `DELETE FROM org_route_assignments WHERE route_id = ANY($1::uuid[]) AND org_id = $2`, routes, w.ids.client)
		w.pool.Exec(ctx, `DELETE FROM org_route_assignments WHERE route_id = ANY($1::uuid[])`, routes)
		w.pool.Exec(ctx, `DELETE FROM routes WHERE id = ANY($1::uuid[])`, routes)
		w.pool.Exec(ctx, `DELETE FROM upstream_connections WHERE id = ANY($1::uuid[])`, []string{cb, poll, nodlr})
		call("POST", "/internal/v1/config/reload", nil, nil)
	})
	if st, err := call("POST", "/internal/v1/config/reload", nil, nil); err != nil || st != 200 {
		t.Fatalf("reload %d %v", st, err)
	}

	// Catalogue.
	var cat struct {
		Adapters []struct {
			ID      string `json:"id"`
			DLRMode string `json:"dlr_mode"`
		} `json:"adapters"`
	}
	if st, err := call("GET", "/internal/v1/adapters", nil, &cat); err != nil || st != 200 || len(cat.Adapters) != 10 {
		t.Fatalf("catalogue %d %v %+v", st, err, cat)
	}

	send := func(route string) (string, string) {
		t.Helper()
		local := "984" + randDigits(7)
		st, r := submit(t, map[string]any{"org_id": w.ids.client, "source": "MYBANK", "destination": "+977 " + local, "text": "Namaste नमस्ते", "route_id": route})
		if st != 200 || r.Status != "ACCEPTED" {
			t.Fatalf("submit %d %+v", st, r)
		}
		return r.MessageID, local
	}
	webhook := func(id string) map[string]any {
		t.Helper()
		var hooks []hookCall
		waitFor(t, "webhook "+id, 10*time.Second, func() bool { hooks = w.hooks.find(id); return len(hooks) > 0 })
		if !hooks[0].ValidSig {
			t.Fatal("webhook signature invalid")
		}
		return hooks[0].Body
	}

	// 1. Callback DLR (MessengerNepal): SUBMITTED with the provider id, then
	//    the provider's webhook (forwarded by the api) delivers it.
	idCB, local := send(rCB)
	row := waitCDR(t, idCB, "SUBMITTED")
	if row.ConnectionID != cb || len(row.SMSCIDs) != 1 || !strings.HasPrefix(row.SMSCIDs[0], "mn-") || row.RouteCost == nil || *row.RouteCost != 300 || row.DLRStat != "" {
		t.Fatalf("cdr %+v", row)
	}
	pb, _ := json.Marshal(map[string]any{"id": "evt", "type": "sms.delivered", "data": map[string]any{"message_id": row.SMSCIDs[0], "status": "delivered", "recipient": "977" + local}})
	var acc struct {
		Accepted int `json:"accepted"`
	}
	fwd := map[string]any{"method": "POST", "query": map[string]any{}, "headers": map[string]string{"content-type": "application/json"}, "body_base64": base64.StdEncoding.EncodeToString(pb)}
	if st, err := call("POST", "/internal/v1/provider-dlr/"+dlrToken, fwd, &acc); err != nil || st != 200 || acc.Accepted != 1 {
		t.Fatalf("provider-dlr %d %v %+v", st, err, acc)
	}
	if st, _ := call("POST", "/internal/v1/provider-dlr/unknown-"+randHex(10), fwd, nil); st != 404 {
		t.Fatalf("unknown token: %d", st)
	}
	row = waitCDR(t, idCB, "DELIVERED")
	if row.DLRStat != "DELIVRD" || row.DLRAt == nil {
		t.Fatalf("cdr %+v", row)
	}
	if b := webhook(idCB); b["status"] != "DELIVERED" || b["dlr_stat"] != "DELIVRD" || b["to"] != "977"+local {
		t.Fatalf("webhook %v", b)
	}

	// 2. Poll DLR (Twozero): the poller finds it delivered.
	idPoll, _ := send(rPoll)
	row = waitCDR(t, idPoll, "DELIVERED")
	if row.ConnectionID != poll || !strings.HasPrefix(row.SMSCIDs[0], "tz-") || row.DLRStat != "DELIVRD" {
		t.Fatalf("cdr %+v", row)
	}
	if b := webhook(idPoll); b["status"] != "DELIVERED" {
		t.Fatalf("webhook %v", b)
	}

	// 3. No DLR (Sparrow): SUBMITTED + NODLR, charged, never failed.
	before := balance(t, w.ids.client)
	idNo, _ := send(rNoDLR)
	waitFor(t, "NODLR", 10*time.Second, func() bool { r, ok := cdrOf(t, idNo); return ok && r.DLRStat == "NODLR" })
	time.Sleep(1500 * time.Millisecond) // a few poll / sweep periods
	row, _ = cdrOf(t, idNo)
	if row.Status != "SUBMITTED" || row.Refunded || len(row.SMSCIDs) != 1 || row.SMSCIDs[0] != idNo || row.ErrorCode != "" {
		t.Fatalf("cdr %+v", row)
	}
	if got := balance(t, w.ids.client); got != before-2000 {
		t.Fatalf("balance %d, want %d", got, before-2000)
	}
	if len(w.hooks.find(idNo)) != 0 {
		t.Fatal("NODLR message produced a webhook")
	}
	prov.mu.Lock()
	for _, tok := range prov.tokens {
		if tok != secret {
			t.Fatalf("provider got token %q", tok)
		}
	}
	prov.mu.Unlock()

	// Status: HTTP connections are READY with a last success.
	var cs struct {
		Connections []struct {
			ID            string  `json:"connection_id"`
			Kind          string  `json:"kind"`
			Adapter       *string `json:"adapter"`
			State         string  `json:"state"`
			LastSuccessAt *string `json:"last_success_at"`
			Submitted     uint64  `json:"submitted_total"`
		} `json:"connections"`
	}
	if st, err := call("GET", "/internal/v1/connections/status", nil, &cs); err != nil || st != 200 {
		t.Fatalf("status %d %v", st, err)
	}
	seen := 0
	for _, c := range cs.Connections {
		switch c.ID {
		case cb, poll, nodlr:
			seen++
			if c.Kind != "HTTP" || c.Adapter == nil || c.State != "READY" || c.LastSuccessAt == nil || c.Submitted != 1 {
				t.Fatalf("http status %+v", c)
			}
		case w.ids.connA:
			if c.Kind != "SMPP" || c.Adapter != nil {
				t.Fatalf("smpp status %+v", c)
			}
		}
	}
	if seen != 3 {
		t.Fatalf("status lists %d HTTP connections", seen)
	}

	// Test send: real request, secret masked in the echo; balance.
	var ts map[string]any
	if st, err := call("POST", "/internal/v1/connections/"+nodlr+"/test", map[string]any{"to": "9841234567", "text": "test"}, &ts); err != nil || st != 200 || ts["ok"] != true {
		t.Fatalf("test send %d %v %v", st, err, ts)
	}
	if b, _ := json.Marshal(ts); strings.Contains(string(b), secret) || !strings.Contains(string(b), "to=9841234567") {
		t.Fatalf("test echo %s", b)
	}
	var bal map[string]any
	if st, err := call("GET", "/internal/v1/connections/"+cb+"/balance", nil, &bal); err != nil || st != 200 || bal["supported"] != false {
		t.Fatalf("balance %d %v %v", st, err, bal)
	}
}

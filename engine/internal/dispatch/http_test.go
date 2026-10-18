package dispatch

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
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

	"smsgw/engine/internal/cdr"
	"smsgw/engine/internal/httpadapter"
	"smsgw/engine/internal/pipeline"
	"smsgw/engine/internal/store"
)

const provTok = "prov-SECRET-token-1"

// provider is a fake HTTP SMS provider.
type provider struct {
	srv     *httptest.Server
	calls   atomic.Int64
	active  atomic.Int64
	maxSeen atomic.Int64
	mu      sync.Mutex
	bodies  []string
	tokens  []string
	handle  func(n int64, r *http.Request, body []byte) (int, string)
	delay   time.Duration
}

func newProvider(t *testing.T, handle func(n int64, r *http.Request, body []byte) (int, string)) *provider {
	t.Helper()
	p := &provider{handle: handle}
	p.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := p.calls.Add(1)
		cur := p.active.Add(1)
		defer p.active.Add(-1)
		for {
			m := p.maxSeen.Load()
			if cur <= m || p.maxSeen.CompareAndSwap(m, cur) {
				break
			}
		}
		b, _ := io.ReadAll(r.Body)
		p.mu.Lock()
		p.bodies = append(p.bodies, string(b))
		p.tokens = append(p.tokens, r.Header.Get("X-API-Key"))
		p.mu.Unlock()
		if p.delay > 0 {
			select {
			case <-time.After(p.delay):
			case <-r.Context().Done():
				return
			}
		}
		st, body := p.handle(n, r, b)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(st)
		io.WriteString(w, body)
	}))
	t.Cleanup(p.srv.Close)
	return p
}

func (p *provider) lastToken() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.tokens) == 0 {
		return ""
	}
	return p.tokens[len(p.tokens)-1]
}

func sparrowOK(int64, *http.Request, []byte) (int, string) {
	return 200, `{"count": 1, "response_code": 200, "response": "1 mesages has been queued for delivery"}`
}

func sparrowBadToken(int64, *http.Request, []byte) (int, string) {
	return 403, `{"response_code": 1002, "response": "Invalid Token", "requested_ip": "1.2.3.4"}`
}

func twozeroOK(n int64, _ *http.Request, _ []byte) (int, string) {
	return 200, `{"status":"success","message":"SMS sent successfully","data":{"message_id":"msg_` + strings.Repeat("x", int(n%5)+1) + `","to":"9841234567","credits_used":1,"status":"sent"}}`
}

func httpConnRow(id, adapter, base string, settings map[string]any) *store.Connection {
	s := map[string]any{"base_url": base}
	for k, v := range settings {
		s[k] = v
	}
	raw, _ := json.Marshal(s)
	return &store.Connection{ID: id, Name: "http-" + id[:6], Kind: store.KindHTTP, Adapter: adapter, MaxTPS: 500, Enabled: true,
		HTTPCredentials: map[string]string{"token": provTok}, HTTPSettings: s, HTTPSettingsRaw: string(raw), DLRToken: "dlr-" + id}
}

func fastHTTP(e *env, o *Options) {
	tr := httpadapter.NewHTTPTransport(nil)
	tr.Timeout = 500 * time.Millisecond
	o.HTTPTransport = tr
	o.HTTPRetryBackoff = 20 * time.Millisecond
}

const npDest = "9779841234567"

func TestHTTPRejectedFailsOverToSMPP(t *testing.T) {
	prov := newProvider(t, sparrowBadToken)
	smsc := newSMSC(t, nil)
	route, ch, cs := uuid.NewString(), uuid.NewString(), uuid.NewString()
	snap := snapshot(route, []*store.Connection{httpConnRow(ch, "sparrow_v2", prov.srv.URL, nil), conn(cs, smsc, ModeUDH)}, []int{1, 2})
	e := newEnvWith(t, snap, route, time.Minute, fastHTTP, nil)
	e.waitBound(cs)
	job := e.enqueue(npDest, "hello", 1)
	var u *cdr.Update
	waitUntil(t, "submitted", func() bool { u = e.sink.find(job.ID, cdr.StatusSubmitted); return u != nil })
	if u.ConnectionID != cs || smsc.count(npDest) != 1 || prov.calls.Load() != 1 {
		t.Fatalf("update %+v smsc=%d provider=%d", u, smsc.count(npDest), prov.calls.Load())
	}
	st := statusOf(t, e.m, ch)
	if st.Kind != "HTTP" || st.State != "ERROR" || st.LastError == nil || !strings.Contains(*st.LastError, "1002") || st.Adapter == nil || *st.Adapter != "sparrow_v2" {
		t.Fatalf("status %+v", st)
	}
	if strings.Contains(*st.LastError, provTok) {
		t.Fatal("token in status")
	}
}

func statusOf(t *testing.T, m *Manager, id string) ConnStatus {
	t.Helper()
	for _, s := range m.Status() {
		if s.ConnectionID == id {
			return s
		}
	}
	t.Fatalf("connection %s not in status", id)
	return ConnStatus{}
}

func TestSMPPRejectedFailsOverToHTTP(t *testing.T) {
	prov := newProvider(t, twozeroOK)
	smsc := newSMSC(t, rejectSuffix("4567"))
	route, ch, cs := uuid.NewString(), uuid.NewString(), uuid.NewString()
	snap := snapshot(route, []*store.Connection{conn(cs, smsc, ModeUDH), httpConnRow(ch, "twozero", prov.srv.URL, nil)}, []int{1, 2})
	e := newEnvWith(t, snap, route, time.Minute, fastHTTP, nil)
	e.waitBound(cs)
	if st := statusOf(t, e.m, ch); st.State != "READY" || len(st.Sessions) != 0 || st.LastSuccessAt != nil {
		t.Fatalf("initial status %+v", st)
	}
	job := e.enqueue(npDest, "hello z", 2) // 2 billed parts, one HTTP request
	var u *cdr.Update
	waitUntil(t, "submitted", func() bool { u = e.sink.find(job.ID, cdr.StatusSubmitted); return u != nil })
	if u.ConnectionID != ch || len(u.SMSCMsgIDs) != 1 || !strings.HasPrefix(u.SMSCMsgIDs[0], "msg_") || u.DLRStat != nil {
		t.Fatalf("update %+v", u)
	}
	// Route cost of the HTTP connection (second in the snapshot: 20/part) × 2 parts.
	if u.RouteCostMicros == nil || *u.RouteCostMicros != 40 {
		t.Fatalf("route cost %v", u.RouteCostMicros)
	}
	ctx := context.Background()
	v, err := e.rdb.Get(ctx, pipeline.DLRMapKey(ch, strings.ToLower(u.SMSCMsgIDs[0]))).Result()
	if err != nil || v != pipeline.DLRMapValue(job.ID, 0, job.CreatedMS) {
		t.Fatalf("dlrmap %q %v", v, err)
	}
	e.rdb.Del(ctx, pipeline.DLRMapKey(ch, strings.ToLower(u.SMSCMsgIDs[0])))
	if h, _ := e.rdb.HGetAll(ctx, pipeline.MsgKey(job.ID)).Result(); h[pipeline.FPDUs] != "1" || h[pipeline.FConnection] != ch {
		t.Fatalf("msg state %v", h)
	}
	if e.bal(e.client) != 10_000-200 {
		t.Fatalf("charged %d", 10_000-e.bal(e.client))
	}
	if st := statusOf(t, e.m, ch); st.State != "READY" || st.LastSuccessAt == nil || st.SubmittedTotal != 1 {
		t.Fatalf("status %+v", st)
	}
	var body map[string]any
	prov.mu.Lock()
	_ = json.Unmarshal([]byte(prov.bodies[0]), &body)
	prov.mu.Unlock()
	if body["to"] != "9841234567" || body["message"] != "hello z" {
		t.Fatalf("provider got %v", body)
	}
}

func TestHTTPNoDLRStaysSubmitted(t *testing.T) {
	prov := newProvider(t, sparrowOK)
	route, ch := uuid.NewString(), uuid.NewString()
	e := newEnvWith(t, snapshot(route, []*store.Connection{httpConnRow(ch, "sparrow_v2", prov.srv.URL, nil)}, []int{1}), route, time.Minute, fastHTTP, nil)
	job := e.enqueue(npDest, "hello", 1)
	var u *cdr.Update
	waitUntil(t, "submitted", func() bool { u = e.sink.find(job.ID, cdr.StatusSubmitted); return u != nil })
	if u.DLRStat == nil || *u.DLRStat != NoDLRStat || len(u.SMSCMsgIDs) != 1 || u.SMSCMsgIDs[0] != job.ID || u.ErrorCode != nil {
		t.Fatalf("update %+v", u)
	}
	waitUntil(t, "acked", func() bool { return e.rdb.XLen(context.Background(), pipeline.DispatchStream(route)).Val() == 0 })
	time.Sleep(100 * time.Millisecond)
	if _, failed := e.fin.failure(job.ID); failed || len(e.fin.unknown(job.ID)) > 0 {
		t.Fatal("NODLR message was finalized")
	}
	if e.bal(e.client) != 10_000-100 {
		t.Fatalf("refunded? balance %d", e.bal(e.client))
	}
	if e.sink.find(job.ID, cdr.StatusFailed) != nil {
		t.Fatal("FAILED written")
	}
	e.rdb.Del(context.Background(), pipeline.DLRMapKey(ch, job.ID))
}

func TestHTTPTimeoutIsUnknownAndNotResent(t *testing.T) {
	prov := newProvider(t, twozeroOK)
	prov.delay = 2 * time.Second // > transport timeout (500ms): timeout after the request was sent
	smsc := newSMSC(t, nil)
	route, ch, cs := uuid.NewString(), uuid.NewString(), uuid.NewString()
	snap := snapshot(route, []*store.Connection{httpConnRow(ch, "twozero", prov.srv.URL, nil), conn(cs, smsc, ModeUDH)}, []int{1, 2})
	e := newEnvWith(t, snap, route, time.Minute, fastHTTP, nil)
	e.waitBound(cs)
	job := e.enqueue(npDest, "hello", 1)
	var u *cdr.Update
	waitUntil(t, "submitted", func() bool { u = e.sink.find(job.ID, cdr.StatusSubmitted); return u != nil })
	if u.ConnectionID != ch || u.ErrorCode == nil || *u.ErrorCode != "SUBMIT_TIMEOUT" {
		t.Fatalf("update %+v", u)
	}
	if got := e.fin.unknown(job.ID); len(got) != 1 || got[0] != 0 {
		t.Fatalf("unknown parts %v", got)
	}
	time.Sleep(200 * time.Millisecond)
	if smsc.count(npDest) != 0 || prov.calls.Load() != 1 {
		t.Fatalf("resent: smsc=%d provider=%d", smsc.count(npDest), prov.calls.Load())
	}
	if e.bal(e.client) != 10_000-100 {
		t.Fatalf("refunded on unknown outcome: %d", e.bal(e.client))
	}
}

func TestHTTPRetriesTransientErrorsOnSameConnection(t *testing.T) {
	prov := newProvider(t, func(n int64, r *http.Request, b []byte) (int, string) {
		if n <= 2 {
			return 503, `{"success":false,"error":"busy","code":"SERVICE_UNAVAILABLE"}`
		}
		return 202, `{"success":true,"data":{"message_id":"661f0001","status":"accepted"}}`
	})
	smsc := newSMSC(t, nil)
	route, ch, cs := uuid.NewString(), uuid.NewString(), uuid.NewString()
	snap := snapshot(route, []*store.Connection{httpConnRow(ch, "messengernepal", prov.srv.URL, nil), conn(cs, smsc, ModeUDH)}, []int{1, 2})
	e := newEnvWith(t, snap, route, time.Minute, fastHTTP, nil)
	e.waitBound(cs)
	job := e.enqueue(npDest, "hello", 1)
	var u *cdr.Update
	waitUntil(t, "submitted", func() bool { u = e.sink.find(job.ID, cdr.StatusSubmitted); return u != nil })
	if u.ConnectionID != ch || u.SMSCMsgIDs[0] != "661f0001" || prov.calls.Load() != 3 || smsc.count(npDest) != 0 || u.DLRStat != nil {
		t.Fatalf("update %+v calls=%d smsc=%d", u, prov.calls.Load(), smsc.count(npDest))
	}
	e.rdb.Del(context.Background(), pipeline.DLRMapKey(ch, "661f0001"))
}

func TestHTTPOnlyRouteFailsAndRefunds(t *testing.T) {
	prov := newProvider(t, func(int64, *http.Request, []byte) (int, string) { return 503, `{}` })
	route, ch := uuid.NewString(), uuid.NewString()
	e := newEnvWith(t, snapshot(route, []*store.Connection{httpConnRow(ch, "twozero", prov.srv.URL, nil)}, []int{1}), route, time.Minute, fastHTTP, nil)
	job := e.enqueue(npDest, "hello", 1)
	waitUntil(t, "failed", func() bool { _, ok := e.fin.failure(job.ID); return ok })
	code, _ := e.fin.failure(job.ID)
	if code != "HTTP_503" || prov.calls.Load() != 3 {
		t.Fatalf("code %s calls %d", code, prov.calls.Load())
	}
	waitUntil(t, "refund", func() bool { return e.bal(e.client) == 10_000 })
}

func TestHTTPNonNepalDestinationSkipsNPAdapter(t *testing.T) {
	prov := newProvider(t, sparrowOK)
	smsc := newSMSC(t, nil)
	route, ch, cs := uuid.NewString(), uuid.NewString(), uuid.NewString()
	snap := snapshot(route, []*store.Connection{httpConnRow(ch, "sparrow_v2", prov.srv.URL, nil), conn(cs, smsc, ModeUDH)}, []int{1, 2})
	e := newEnvWith(t, snap, route, time.Minute, fastHTTP, nil)
	e.waitBound(cs)
	job := e.enqueue("447700900123", "hello", 1)
	var u *cdr.Update
	waitUntil(t, "submitted", func() bool { u = e.sink.find(job.ID, cdr.StatusSubmitted); return u != nil })
	if u.ConnectionID != cs || prov.calls.Load() != 0 {
		t.Fatalf("update %+v provider calls %d", u, prov.calls.Load())
	}
	if st := statusOf(t, e.m, ch); st.State != "READY" {
		t.Fatalf("a destination mismatch must not mark the connection ERROR: %+v", st)
	}
}

func TestHTTPMaxConcurrencyAndLiveConfig(t *testing.T) {
	prov := newProvider(t, twozeroOK)
	prov.delay = 150 * time.Millisecond
	route, ch := uuid.NewString(), uuid.NewString()
	row := httpConnRow(ch, "twozero", prov.srv.URL, map[string]any{"max_concurrency": 2})
	e := newEnvWith(t, snapshot(route, []*store.Connection{row}, []int{1}), route, time.Minute, fastHTTP, nil)
	var jobs []*pipeline.DispatchJob
	for i := 0; i < 6; i++ {
		jobs = append(jobs, e.enqueue(npDest, "hello", 1))
	}
	for _, j := range jobs {
		waitUntil(t, "submitted", func() bool { return e.sink.find(j.ID, cdr.StatusSubmitted) != nil })
	}
	if m := prov.maxSeen.Load(); m != 2 {
		t.Fatalf("max concurrent requests %d, want 2", m)
	}
	// A credentials change applies to the next request (nothing to rebind).
	row2 := httpConnRow(ch, "twozero", prov.srv.URL, map[string]any{"max_concurrency": 2})
	row2.HTTPCredentials = map[string]string{"token": "rotated-token-2"}
	e.src.set(snapshot(route, []*store.Connection{row2}, []int{1}))
	waitUntil(t, "new config", func() bool { return e.m.src.Current().Connection(ch).HTTPCredentials["token"] == "rotated-token-2" })
	j := e.enqueue(npDest, "again", 1)
	waitUntil(t, "submitted", func() bool { return e.sink.find(j.ID, cdr.StatusSubmitted) != nil })
	if prov.lastToken() != "rotated-token-2" {
		t.Fatalf("token %q", prov.lastToken())
	}
	ctx := context.Background()
	for i := 1; i <= 5; i++ {
		e.rdb.Del(ctx, pipeline.DLRMapKey(ch, "msg_"+strings.Repeat("x", i)))
	}
}

func TestHTTPTestSendMasksSecrets(t *testing.T) {
	prov := newProvider(t, func(n int64, r *http.Request, b []byte) (int, string) {
		v, _ := url.ParseQuery(string(b))
		if v.Get("to") == "9800000000" {
			return 403, `{"response_code": 1007, "response": "Invalid Receiver"}`
		}
		return 200, `{"count": 1, "response_code": 200, "response": "1 mesages has been queued for delivery", "echo": "` + provTok + `"}`
	})
	smsc := newSMSC(t, nil)
	route, ch, cs := uuid.NewString(), uuid.NewString(), uuid.NewString()
	snap := snapshot(route, []*store.Connection{httpConnRow(ch, "sparrow_v2", prov.srv.URL, map[string]any{"sender": "TEST"}), conn(cs, smsc, ModeUDH)}, []int{1, 2})
	e := newEnvWith(t, snap, route, time.Minute, fastHTTP, nil)
	ctx := context.Background()
	res, err := e.m.TestSend(ctx, ch, "9841234567", "test message", "")
	if err != nil || !res.OK || res.HTTPStatus != 200 || res.Request == nil || res.Error != nil || res.ProviderMessageID != nil {
		t.Fatalf("%+v %v", res, err)
	}
	all, _ := json.Marshal(res)
	if strings.Contains(string(all), provTok) || strings.Contains(string(all), url.QueryEscape(provTok)) || !strings.Contains(res.Request.Body, "token=%2A%2A%2A") && !strings.Contains(res.Request.Body, "token=***") {
		t.Fatalf("secret not masked: %s", all)
	}
	if !strings.Contains(res.Request.Body, "to=9841234567") || res.Request.Method != "POST" || !strings.Contains(res.ResponseBody, "queued") {
		t.Fatalf("echo %+v", res)
	}
	res, _ = e.m.TestSend(ctx, ch, "9800000000", "x", "")
	if res.OK || res.Error == nil || !strings.Contains(*res.Error, "1007") {
		t.Fatalf("%+v", res)
	}
	if st := statusOf(t, e.m, ch); st.State != "READY" || st.LastSuccessAt == nil {
		t.Fatalf("recipient error must not flip state: %+v", st)
	}
	res, _ = e.m.TestSend(ctx, ch, "+44 7700 900123", "x", "")
	if res.OK || res.Error == nil || !strings.Contains(*res.Error, "NP") {
		t.Fatalf("%+v", res)
	}
	res, _ = e.m.TestSend(ctx, cs, "9841234567", "x", "")
	if res.OK || res.Error == nil || *res.Error != "test send is HTTP-only" {
		t.Fatalf("smpp: %+v", res)
	}
	if _, err := e.m.TestSend(ctx, uuid.NewString(), "9841234567", "x", ""); !errors.Is(err, ErrConnectionNotFound) {
		t.Fatal(err)
	}
	b, err := e.m.ProviderBalance(ctx, cs)
	if err != nil || b.Supported {
		t.Fatalf("smpp balance %+v", b)
	}
}

// fakeReceipts records provider receipts.
type fakeReceipts struct {
	mu   sync.Mutex
	got  []string
	only map[string]bool
}

func (f *fakeReceipts) HandleProviderReceipt(_ context.Context, connID, id, stat, _ string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.got = append(f.got, connID+"|"+id+"|"+stat)
	return f.only == nil || f.only[id], nil
}

func (f *fakeReceipts) list() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.got...)
}

func TestHTTPDLRPollAndCallback(t *testing.T) {
	prov := newProvider(t, func(n int64, r *http.Request, b []byte) (int, string) {
		switch r.URL.Path {
		case "/sms/status/msg_a":
			return 200, `{"status":"success","data":{"status":"delivered"}}`
		case "/sms/status/msg_b":
			return 200, `{"status":"success","data":{"status":"pending"}}`
		}
		return 404, `{"status":"error","message":"not found","data":null}`
	})
	route, cpoll, ccb := uuid.NewString(), uuid.NewString(), uuid.NewString()
	rcpt := &fakeReceipts{}
	var asked atomic.Int64
	pending := func(_ context.Context, connID string, _ time.Time, limit int) ([]httpadapter.Pending, error) {
		if connID != cpoll {
			t.Errorf("pending asked for %s", connID)
		}
		asked.Add(1)
		return []httpadapter.Pending{{MessageID: "m1", ProviderID: "msg_a"}, {MessageID: "m2", ProviderID: "msg_b"}}, nil
	}
	cb := httpConnRow(ccb, "messengernepal", "http://127.0.0.1:1", nil)
	cb.HTTPCredentials["webhook_secret"] = "whsec-1"
	snap := snapshot(route, []*store.Connection{httpConnRow(cpoll, "twozero", prov.srv.URL, nil), cb}, []int{1, 2})
	e := newEnvWith(t, snap, route, time.Minute, func(e *env, o *Options) {
		fastHTTP(e, o)
		o.Receipts, o.Pending, o.PollTick, o.PollInterval = rcpt, pending, 20*time.Millisecond, 200*time.Millisecond
	}, nil)
	t.Cleanup(func() { e.rdb.Del(context.Background(), "httpdlr:poll:"+cpoll) })
	waitUntil(t, "poll receipt", func() bool { return len(rcpt.list()) > 0 })
	if got := rcpt.list(); got[0] != cpoll+"|msg_a|DELIVRD" {
		t.Fatalf("receipts %v", got)
	}

	// Callback: unknown token, bad signature, good one.
	ctx := context.Background()
	if _, err := e.m.ProviderDLR(ctx, "nope", &httpadapter.Callback{}); !errors.Is(err, ErrConnectionNotFound) {
		t.Fatal(err)
	}
	body := []byte(`{"type":"sms.delivered","data":{"message_id":"661f9","status":"delivered"}}`)
	if _, err := e.m.ProviderDLR(ctx, "dlr-"+ccb, &httpadapter.Callback{Body: body, Headers: map[string]string{"x-msngr-signature": "sha256=00"}}); !errors.Is(err, httpadapter.ErrBadSignature) {
		t.Fatalf("bad signature: %v", err)
	}
	n, err := e.m.ProviderDLR(ctx, "dlr-"+ccb, &httpadapter.Callback{Body: body, Headers: map[string]string{
		"x-msngr-timestamp": "1", "x-msngr-signature": "sha256=" + hmacHex("whsec-1", "1."+string(body))}})
	if err != nil || n != 1 {
		t.Fatalf("callback %d %v", n, err)
	}
	if got := rcpt.list(); got[len(got)-1] != ccb+"|661f9|DELIVRD" {
		t.Fatalf("receipts %v", got)
	}
}

func hmacHex(key, msg string) string {
	m := hmac.New(sha256.New, []byte(key))
	m.Write([]byte(msg))
	return hex.EncodeToString(m.Sum(nil))
}

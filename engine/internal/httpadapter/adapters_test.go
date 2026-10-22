package httpadapter

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

// --- fake provider -----------------------------------------------------------

type rec struct {
	Method, Path, Query string
	Header              http.Header
	Body                []byte
}

func (r rec) form(t *testing.T) url.Values {
	t.Helper()
	v, err := url.ParseQuery(string(r.Body))
	if err != nil {
		t.Fatalf("form: %v", err)
	}
	return v
}

func (r rec) json(t *testing.T) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(r.Body, &m); err != nil {
		t.Fatalf("json body %q: %v", r.Body, err)
	}
	return m
}

type reply struct {
	status int
	body   string
	header map[string]string
	delay  time.Duration
}

type fake struct {
	srv   *httptest.Server
	mu    sync.Mutex
	reqs  []rec
	route func(r rec) reply
}

func newFake(t *testing.T, route func(r rec) reply) *fake {
	t.Helper()
	f := &fake{route: route}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		rr := rec{Method: r.Method, Path: r.URL.Path, Query: r.URL.RawQuery, Header: r.Header.Clone(), Body: b}
		f.mu.Lock()
		f.reqs = append(f.reqs, rr)
		f.mu.Unlock()
		rp := f.route(rr)
		if rp.delay > 0 {
			select {
			case <-time.After(rp.delay):
			case <-r.Context().Done():
				return
			}
		}
		for k, v := range rp.header {
			w.Header().Set(k, v)
		}
		if rp.status == 0 {
			rp.status = 200
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(rp.status)
		io.WriteString(w, rp.body)
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fake) last(t *testing.T) rec {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.reqs) == 0 {
		t.Fatal("no request reached the fake provider")
	}
	return f.reqs[len(f.reqs)-1]
}

func (f *fake) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.reqs)
}

func always(status int, body string) func(rec) reply {
	return func(rec) reply { return reply{status: status, body: body} }
}

const secretTok = "tok-SECRET-12345"

func conn(t *testing.T, id string, creds map[string]string, settings map[string]any) *Conn {
	t.Helper()
	a := Get(id)
	if a == nil {
		t.Fatalf("adapter %s not registered", id)
	}
	info := a.Info()
	tr := NewHTTPTransport(nil)
	tr.Timeout = 2 * time.Second
	return NewConn("c1", &info, creds, settings, "dlrtok", tr)
}

func msg() *Message {
	return &Message{ID: "0192a6b0-0000-7000-8000-000000000001", To: "9779841234567", Text: "Hello नमस्ते", Source: "ACME", Encoding: "UCS2", Parts: 1}
}

func send(t *testing.T, id string, c *Conn, m *Message) SendResult {
	t.Helper()
	return Get(id).Send(context.Background(), c, m)
}

func wantOutcome(t *testing.T, r SendResult, o Outcome, code string) {
	t.Helper()
	if r.Outcome != o || (code != "" && r.ErrorCode != code) {
		t.Fatalf("outcome %v code %q (err %q), want %v %q", r.Outcome, r.ErrorCode, r.Error, o, code)
	}
	if strings.Contains(r.Error, secretTok) {
		t.Fatalf("secret leaked in error: %q", r.Error)
	}
}

// --- catalogue -----------------------------------------------------------------

func TestCatalogue(t *testing.T) {
	want := []string{"sparrow_v2", "aakash_v3", "aakash_v4", "swift_smartsms", "messengernepal", "twozero", "nestsms", "bulletsms", "bitmoro", "kavrelisms", "generic_http"}
	cat := Catalogue()
	if len(cat) != len(want) {
		t.Fatalf("catalogue has %d adapters", len(cat))
	}
	for i, info := range cat {
		if info.ID != want[i] {
			t.Fatalf("order: %d = %s, want %s", i, info.ID, want[i])
		}
		if info.Name == "" || (info.Confidence != ConfidenceVerified && info.Confidence != ConfidenceLikely) {
			t.Fatalf("%s: incomplete %+v", info.ID, info)
		}
		switch info.DLRMode {
		case DLRNone, DLRPoll, DLRCallback:
		default:
			t.Fatalf("%s: dlr_mode %q", info.ID, info.DLRMode)
		}
		a := Get(info.ID)
		if _, ok := a.(BalanceChecker); ok != info.SupportsBalance {
			t.Fatalf("%s: supports_balance %v but BalanceChecker %v", info.ID, info.SupportsBalance, ok)
		}
		if _, ok := a.(DLRPoller); ok != (info.DLRMode == DLRPoll) {
			t.Fatalf("%s: poll mode / DLRPoller mismatch", info.ID)
		}
		if _, ok := a.(CallbackParser); ok != (info.DLRMode == DLRCallback) {
			t.Fatalf("%s: callback mode / CallbackParser mismatch", info.ID)
		}
		if info.ID == "generic_http" {
			if info.DestinationCountries != nil {
				t.Fatal("generic_http must accept any destination")
			}
		} else if len(info.DestinationCountries) != 1 || info.DestinationCountries[0] != "NP" || info.Country != "NP" {
			t.Fatalf("%s: countries %v", info.ID, info.DestinationCountries)
		}
		for _, s := range info.Settings {
			switch s.Type {
			case TypeURL, TypeString, TypeNumber, TypeBool, TypeSelect:
			default:
				t.Fatalf("%s.%s: type %q", info.ID, s.Key, s.Type)
			}
			if s.Type == TypeSelect && len(s.Options) == 0 {
				t.Fatalf("%s.%s: select without options", info.ID, s.Key)
			}
		}
	}
	conf := map[string]string{}
	for _, i := range cat {
		conf[i.ID] = i.Confidence
	}
	for id, c := range map[string]string{"sparrow_v2": "VERIFIED", "aakash_v3": "VERIFIED", "aakash_v4": "VERIFIED", "messengernepal": "VERIFIED",
		"twozero": "VERIFIED", "nestsms": "LIKELY", "swift_smartsms": "LIKELY", "bulletsms": "LIKELY", "bitmoro": "LIKELY"} {
		if conf[id] != c {
			t.Fatalf("%s confidence %s, want %s", id, conf[id], c)
		}
	}
	b, err := json.Marshal(map[string]any{"adapters": cat})
	if err != nil || !strings.Contains(string(b), `"docs_url":null`) || !strings.Contains(string(b), `"destination_countries":null`) {
		t.Fatalf("json: %v %s", err, b[:200])
	}
}

func TestNepalFormatting(t *testing.T) {
	for in, want := range map[string]string{"9779841234567": "9841234567", "+977 984-1234567": "9841234567", "009779801234567": "9801234567",
		"9841234567": "9841234567", "919876543210": "", "97714234567": "", "9771234567890": ""} {
		if got := NepalLocal(in); got != want {
			t.Errorf("NepalLocal(%q) = %q, want %q", in, got, want)
		}
	}
	info := Get("sparrow_v2").Info()
	if AcceptsDestination(&info, "919876543210") || !AcceptsDestination(&info, "9779841234567") {
		t.Fatal("NP-only check")
	}
	g := Get("generic_http").Info()
	if !AcceptsDestination(&g, "919876543210") {
		t.Fatal("generic accepts any")
	}
	if FormatRecipient("9779841234567", "plus977") != "+9779841234567" || FormatRecipient("9779841234567", "e164") != "+9779841234567" ||
		FormatRecipient("919876543210", "national") != "9876543210" || FormatRecipient("9779841234567", "msisdn") != "9779841234567" {
		t.Fatal("FormatRecipient")
	}
}

func TestMasking(t *testing.T) {
	c := conn(t, "swift_smartsms", map[string]string{"username": "bob", "password": "p@ss w/rd+1", "organisation_code": "ORG1"}, nil)
	in := `pw=p@ss w/rd+1 q=p%40ss+w%2Frd%2B1 path=p@ss%20w%2Frd+1 user=bob b64=` + "cEBzcyB3L3JkKzE="
	out := c.Mask(in)
	if strings.Contains(out, "p@ss") || strings.Contains(out, "p%40ss") || strings.Contains(out, "cEBzcyB3L3JkKzE=") || !strings.Contains(out, "user=bob") {
		t.Fatalf("mask: %s", out)
	}
	r := c.MaskRequest(&Request{Method: "POST", URL: "https://x/?password=p%40ss+w%2Frd%2B1", Header: http.Header{"Authorization": {"Basic Ym9iOnBAc3Mgdy9yZCsx"}},
		Body: []byte(`{"pw":"p@ss w/rd+1"}`)})
	if strings.Contains(r.URL, "p%40ss") || strings.Contains(string(r.Body), "p@ss") || r.Header.Get("Authorization") != "Basic ***" {
		t.Fatalf("masked request %+v %s", r, r.Body)
	}
}

// --- transport classification -------------------------------------------------

func TestTransportOutcomes(t *testing.T) {
	cases := []struct {
		name  string
		rp    reply
		out   Outcome
		code  string
		after time.Duration
	}{
		{"503 retry", reply{status: 503, body: `{"success":false,"error":"down","code":"SERVICE_UNAVAILABLE"}`}, Retry, "HTTP_503", 0},
		{"500 retry", reply{status: 500, body: `oops`}, Retry, "HTTP_500", 0},
		{"429 retry-after", reply{status: 429, body: `{"success":false,"error":"slow down","code":"RATE_LIMIT_EXCEEDED","retry_after":7}`, header: map[string]string{"Retry-After": "7"}}, Retry, "HTTP_429", 7 * time.Second},
		{"408 retry", reply{status: 408}, Retry, "HTTP_408", 0},
		{"504 unknown", reply{status: 504}, Unknown, "SUBMIT_TIMEOUT", 0},
		{"timeout after send", reply{status: 202, body: `{}`, delay: 3 * time.Second}, Unknown, "SUBMIT_TIMEOUT", 0},
		{"2xx garbage", reply{status: 200, body: `<html>ok</html>`}, Unknown, "SUBMIT_UNKNOWN", 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newFake(t, func(rec) reply { return tc.rp })
			c := conn(t, "messengernepal", map[string]string{"token": secretTok}, map[string]any{"base_url": f.srv.URL})
			r := send(t, "messengernepal", c, msg())
			wantOutcome(t, r, tc.out, tc.code)
			if r.RetryAfter != tc.after {
				t.Fatalf("retry after %v", r.RetryAfter)
			}
		})
	}
	t.Run("connection refused retry", func(t *testing.T) {
		l, _ := net.Listen("tcp", "127.0.0.1:0")
		addr := l.Addr().String()
		l.Close()
		c := conn(t, "twozero", map[string]string{"token": secretTok}, map[string]any{"base_url": "http://" + addr})
		wantOutcome(t, send(t, "twozero", c, msg()), Retry, "HTTP_NETWORK")
		// A token in the URL never reaches the error text (net/http puts the URL there).
		g := conn(t, "generic_http", map[string]string{"token": "abc-SECRET-token"}, map[string]any{"url": "http://" + addr + "/s?key={token}", "params": `{}`})
		r := send(t, "generic_http", g, msg())
		wantOutcome(t, r, Retry, "HTTP_NETWORK")
		if strings.Contains(r.Error, "SECRET") || strings.Contains(r.Error, "/s?key") {
			t.Fatalf("URL leaked into error: %s", r.Error)
		}
	})
	t.Run("non-NP destination never sent", func(t *testing.T) {
		f := newFake(t, always(200, `{}`))
		for _, id := range []string{"sparrow_v2", "aakash_v3", "aakash_v4", "messengernepal", "twozero", "bulletsms", "bitmoro", "swift_smartsms"} {
			c := conn(t, id, map[string]string{"token": secretTok, "username": "u", "password": "pppp", "organisation_code": "o"}, map[string]any{"base_url": f.srv.URL})
			m := msg()
			m.To = "919876543210"
			wantOutcome(t, send(t, id, c, m), Rejected, "DESTINATION_NOT_SUPPORTED")
		}
		if f.count() != 0 {
			t.Fatal("request was sent")
		}
	})
}

// --- Sparrow -------------------------------------------------------------------

func TestSparrow(t *testing.T) {
	f := newFake(t, func(r rec) reply {
		if r.Path == "/v2/credit/" {
			return reply{body: `{"credits_available": 1520, "credits_consumed": 80, "response_code": 200}`}
		}
		switch r.form(t).Get("to") {
		case "9841234567":
			return reply{body: `{"count": 1, "response_code": 200, "response": "1 mesages has been queued for delivery"}`}
		case "9800000000":
			return reply{status: 403, body: `{"response_code": 1007, "response": "Invalid Receiver", "requested_ip": "1.2.3.4"}`}
		}
		return reply{status: 403, body: `{"response_code": 1002, "response": "Invalid Token", "requested_ip": "1.2.3.4"}`}
	})
	c := conn(t, "sparrow_v2", map[string]string{"token": secretTok}, map[string]any{"base_url": f.srv.URL + "/v2", "sender": "TheAlert"})
	r := send(t, "sparrow_v2", c, msg())
	wantOutcome(t, r, Accepted, "")
	if r.ProviderID() != "" {
		t.Fatal("sparrow returns no id")
	}
	req := f.last(t)
	fv := req.form(t)
	if req.Method != "POST" || req.Path != "/v2/sms/" || fv.Get("token") != secretTok || fv.Get("from") != "TheAlert" ||
		fv.Get("to") != "9841234567" || fv.Get("text") != "Hello नमस्ते" || req.Header.Get("User-Agent") != "smsgw/1.0" {
		t.Fatalf("request %+v %v", req, fv)
	}
	masked := c.MaskRequest(r.Exchange.Request)
	if strings.Contains(string(masked.Body), secretTok) || strings.Contains(string(masked.Body), url.QueryEscape(secretTok)) {
		t.Fatalf("token in masked body: %s", masked.Body)
	}

	m := msg()
	m.To = "9779800000000"
	r = send(t, "sparrow_v2", c, m)
	wantOutcome(t, r, Rejected, "1007")
	if !r.RecipientError {
		t.Fatal("1007 is a recipient error")
	}
	m.To = "9779811111111"
	r = send(t, "sparrow_v2", c, m)
	wantOutcome(t, r, Rejected, "1002")
	if r.RecipientError || !strings.Contains(r.Error, "Invalid Token") {
		t.Fatalf("1002: %+v", r)
	}

	// Blank sender: the message's sender (Sparrow requires from).
	c2 := conn(t, "sparrow_v2", map[string]string{"token": secretTok}, map[string]any{"base_url": f.srv.URL + "/v2"})
	send(t, "sparrow_v2", c2, msg())
	if f.last(t).form(t).Get("from") != "ACME" {
		t.Fatal("from should default to the message sender")
	}

	b := Get("sparrow_v2").(BalanceChecker).Balance(context.Background(), c)
	if b.Balance != "1520" || b.Error != "" || f.last(t).Method != "GET" || !strings.Contains(f.last(t).Query, "token=") {
		t.Fatalf("balance %+v", b)
	}
}

func TestKavreliSMS(t *testing.T) {
	f := newFake(t, func(r rec) reply {
		switch r.form(t).Get("mobile") {
		case "9841234567":
			return reply{status: 200, body: `{"status":"success","message":"SMS sent successfully."}`}
		case "9800000000":
			// 2xx body that reports an error → rejection.
			return reply{status: 200, body: `{"status":"error","message":"insufficient credits"}`}
		}
		return reply{status: 400, body: `{"status":"error","message":"Missing mobile or message parameter."}`}
	})
	// No credentials: the page is called with just mobile and message.
	c := conn(t, "kavrelisms", nil, map[string]any{"base_url": f.srv.URL + "/page.aspx"})

	r := send(t, "kavrelisms", c, msg())
	wantOutcome(t, r, Accepted, "")
	if r.ProviderID() != "" {
		t.Fatal("kavrelisms returns no id")
	}
	// Accept is the delivery signal: messages are recorded DELIVERED, not NODLR.
	if EffectiveDLRMode(Get("kavrelisms"), c) != DLRNone || !DeliveredOnAccept(Get("kavrelisms"), c) {
		t.Fatal("kavrelisms should have no DLR and deliver on accept")
	}
	req := f.last(t)
	fv := req.form(t)
	if req.Method != "POST" || req.Path != "/page.aspx" ||
		!strings.HasPrefix(req.Header.Get("Content-Type"), "application/x-www-form-urlencoded") ||
		fv.Get("mobile") != "9841234567" || fv.Get("message") != "Hello नमस्ते" {
		t.Fatalf("request %+v form %v", req, fv)
	}

	m := msg()
	m.To = "9779800000000"
	r = send(t, "kavrelisms", c, m)
	wantOutcome(t, r, Rejected, "PROVIDER_ERROR")

	m.To = "9779811111111"
	r = send(t, "kavrelisms", c, m)
	wantOutcome(t, r, Rejected, "HTTP_400")

	// Non-Nepali destination is rejected before any request.
	before := f.count()
	m.To = "14155550123"
	r = send(t, "kavrelisms", c, m)
	wantOutcome(t, r, Rejected, "DESTINATION_NOT_SUPPORTED")
	if f.count() != before {
		t.Fatal("no request should be sent for a non-NP number")
	}

	// Missing base URL is a config error.
	c2 := conn(t, "kavrelisms", nil, map[string]any{})
	wantOutcome(t, send(t, "kavrelisms", c2, msg()), Rejected, "BAD_CONFIG")
}

// --- Aakash --------------------------------------------------------------------

func TestAakashV3(t *testing.T) {
	f := newFake(t, func(r rec) reply {
		switch r.Path {
		case "/sms/v1/credit":
			return reply{body: `{"available_credit": 300, "total_sms_sent": 12, "response_code": 202}`}
		case "/sms/v1/report/api":
			switch r.form(t).Get("page") {
			case "1":
				return reply{body: `{"error":false,"total_page":2,"response_code":"201","data":[{"id":2673160,"receiver":"984*******","network":"ntc","message":"x","api_credit":"1","delivery_at":"2026-10-18 16:35:01"},{"id":2673161,"receiver":"984*******","network":"ntc","message":"y","api_credit":"1","delivery_at":null}]}`}
			default:
				return reply{body: `{"error":false,"total_page":2,"response_code":"201","data":[{"id":2673170,"receiver":"981*******","network":"ncell","message":"z","api_credit":"1","delivery_at":"2026-10-18 16:40:00"}]}`}
			}
		}
		fv := r.form(t)
		if fv.Get("auth_token") != secretTok {
			return reply{body: `{"error":true,"message":"The provided Auth Token is not valid.","data":[]}`}
		}
		switch fv.Get("to") {
		case "9818000000":
			return reply{body: `{"error": false, "message": "1 messages has been queued for delivery.", "data": {"valid": [{"id": 2673160, "mobile": "9779818000000", "text": "v3 sms test", "credit": 1, "network": "ncell", "status": "queued"}], "invalid": []}}`}
		case "9885855840":
			return reply{body: `{"error": false, "message": "0 messages has been queued for delivery.", "data": {"valid": [], "invalid": [{"mobile": "9885855840", "text": "v3 sms test", "credit": 0, "network": "N/A", "status": "aborted"}]}}`}
		}
		return reply{body: `{"error":true,"message":"Not enough balance.","data":[]}`}
	})
	c := conn(t, "aakash_v3", map[string]string{"token": secretTok}, map[string]any{"base_url": f.srv.URL + "/sms/"})
	m := msg()
	m.To = "9779818000000"
	r := send(t, "aakash_v3", c, m)
	wantOutcome(t, r, Accepted, "")
	if r.ProviderID() != "2673160" {
		t.Fatalf("id %v", r.ProviderIDs)
	}
	req := f.last(t)
	if req.Path != "/sms/v3/send" || req.form(t).Get("to") != "9818000000" || req.form(t).Get("text") != m.Text {
		t.Fatalf("request %+v", req)
	}
	// 200 with error=true (the live-probed invalid-token answer).
	bad := conn(t, "aakash_v3", map[string]string{"token": "wrong-token"}, map[string]any{"base_url": f.srv.URL + "/sms"})
	r = send(t, "aakash_v3", bad, m)
	wantOutcome(t, r, Rejected, "INVALID_TOKEN")
	if r.HTTPStatus != 200 || r.RecipientError {
		t.Fatalf("%+v", r)
	}
	// Per-recipient rejection inside an error=false answer.
	m.To = "9779885855840"
	r = send(t, "aakash_v3", c, m)
	wantOutcome(t, r, Rejected, "INVALID_RECIPIENT")
	if !r.RecipientError {
		t.Fatal("aborted number is a recipient error")
	}
	m.To = "9779841111111"
	wantOutcome(t, send(t, "aakash_v3", c, m), Rejected, "INSUFFICIENT_BALANCE")

	rc, err := Get("aakash_v3").(DLRPoller).PollDLR(context.Background(), c, []Pending{{ProviderID: "2673160"}, {ProviderID: "2673161"}, {ProviderID: "2673170"}, {ProviderID: "999"}})
	if err != nil || len(rc) != 2 || rc[0].ProviderID != "2673160" || rc[0].Stat != "DELIVRD" || rc[1].ProviderID != "2673170" {
		t.Fatalf("poll %+v %v", rc, err)
	}
	b := Get("aakash_v3").(BalanceChecker).Balance(context.Background(), c)
	if b.Balance != "300" || b.Error != "" {
		t.Fatalf("balance %+v", b)
	}
}

func TestAakashV4(t *testing.T) {
	f := newFake(t, func(r rec) reply {
		if r.Path == "/sms/v4/available-credit" {
			if r.Header.Get("auth-token") != secretTok {
				return reply{status: 401, body: `{"error":true,"message":"Authentication token is invalid or expired","response_code":401,"data":[]}`}
			}
			return reply{body: `{"available_credit": 77, "response_code": 200}`}
		}
		body := r.json(t)
		to := body["to"].([]any)[0].(string)
		if to == "9800000001" {
			return reply{body: `{"error":true,"message":"All messages encountered errors.","errors":[{"error":true,"message":"Not enough balance.","data":{}}]}`}
		}
		return reply{body: `{"responses":[{"error":false,"message":"1 messages has been queued for delivery.","data":{"valid":[{"id":"8967_173191065276114","mobile":"9779841234567","text":"x","credit":1,"network":"ntc","status":"queued","shortcode":"AAKASH"}],"invalid":[]}}],"errors":[]}`}
	})
	c := conn(t, "aakash_v4", map[string]string{"token": secretTok}, map[string]any{"base_url": f.srv.URL + "/sms"})
	r := send(t, "aakash_v4", c, msg())
	wantOutcome(t, r, Accepted, "")
	if r.ProviderID() != "8967_173191065276114" {
		t.Fatalf("id %v", r.ProviderIDs)
	}
	req := f.last(t)
	b := req.json(t)
	if req.Path != "/sms/v4/send-user" || req.Header.Get("auth-token") != secretTok || b["to"].([]any)[0] != "9841234567" || b["text"].([]any)[0] != "Hello नमस्ते" {
		t.Fatalf("request %+v %v", req, b)
	}
	m := msg()
	m.To = "9779800000001"
	wantOutcome(t, send(t, "aakash_v4", c, m), Rejected, "INSUFFICIENT_BALANCE")
	if bal := Get("aakash_v4").(BalanceChecker).Balance(context.Background(), c); bal.Balance != "77" {
		t.Fatalf("balance %+v", bal)
	}
	bad := conn(t, "aakash_v4", map[string]string{"token": "nope-nope"}, map[string]any{"base_url": f.srv.URL + "/sms"})
	if bal := Get("aakash_v4").(BalanceChecker).Balance(context.Background(), bad); bal.Error == "" || !strings.Contains(bal.Raw, "invalid or expired") {
		t.Fatalf("balance error %+v", bal)
	}
}

// --- MessengerNepal / Nest -----------------------------------------------------------

func TestMessengerNepal(t *testing.T) {
	f := newFake(t, func(r rec) reply {
		b := r.json(t)
		if b["to"] == "9800000002" {
			return reply{status: 400, body: `{"success":false,"error":"Insufficient credits","code":"INSUFFICIENT_CREDITS"}`}
		}
		return reply{status: 202, body: `{"success":true,"message":"SMS accepted for delivery","data":{"dispatch_id":"661f00aa","job_id":"661f00aa","message_id":"661f00aa","status":"accepted","environment":"live","recipient":"9841234567","cost":1,"remaining_balance":482,"remaining_credits":482}}`}
	})
	c := conn(t, "messengernepal", map[string]string{"token": secretTok}, map[string]any{"base_url": f.srv.URL + "/api/v1", "message_type": "otp"})
	r := send(t, "messengernepal", c, msg())
	wantOutcome(t, r, Accepted, "")
	req := f.last(t)
	b := req.json(t)
	if r.ProviderID() != "661f00aa" || req.Path != "/api/v1/sms/send" || req.Header.Get("X-API-Key") != secretTok ||
		req.Header.Get("Idempotency-Key") != msg().ID || b["to"] != "9841234567" || b["message"] != "Hello नमस्ते" || b["message_type"] != "otp" || b["sender_id"] != nil {
		t.Fatalf("request %+v %v", req, b)
	}
	cs := conn(t, "messengernepal", map[string]string{"token": secretTok}, map[string]any{"base_url": f.srv.URL + "/api/v1", "sender": "ALERT"})
	send(t, "messengernepal", cs, msg())
	if req := f.last(t); req.Path != "/api/v1/sms/send/with-sender-id" || req.json(t)["sender_id"] != "ALERT" {
		t.Fatalf("with sender: %+v", req)
	}
	m := msg()
	m.To = "9779800000002"
	wantOutcome(t, send(t, "messengernepal", c, m), Rejected, "INSUFFICIENT_CREDITS")
}

func TestMessengerNepalCallback(t *testing.T) {
	c := conn(t, "messengernepal", map[string]string{"token": secretTok, "webhook_secret": "whsec-xyz"}, nil)
	body := `{"id":"evt_1","type":"sms.delivered","created_at":"2026-10-18T10:00:00Z","data":{"message_id":"661f00aa","dispatch_id":"661f00aa","batch_id":null,"status":"delivered","channel":"sms","recipient":"9779841234567","sent_at":"2026-10-18T10:00:00Z","delivered_at":"2026-10-18T10:00:05Z","failed_at":null,"error_code":null,"error_message":null,"cost":1,"environment":"live"}}`
	ts := "1760781600"
	mac := hmac.New(sha256.New, []byte("whsec-xyz"))
	mac.Write([]byte(ts + "." + body))
	sig := "sha256=" + hex.EncodeToString(mac.Sum(nil))
	p := Get("messengernepal").(CallbackParser)
	rc, err := p.ParseCallback(c, &Callback{Method: "POST", Headers: map[string]string{"x-msngr-signature": sig, "x-msngr-timestamp": ts}, Body: []byte(body)})
	if err != nil || len(rc) != 1 || rc[0].ProviderID != "661f00aa" || rc[0].Stat != "DELIVRD" {
		t.Fatalf("%+v %v", rc, err)
	}
	if _, err := p.ParseCallback(c, &Callback{Headers: map[string]string{"x-msngr-signature": "sha256=00", "x-msngr-timestamp": ts}, Body: []byte(body)}); err != ErrBadSignature {
		t.Fatalf("bad signature accepted: %v", err)
	}
	failed := strings.Replace(strings.Replace(body, `"delivered"`, `"failed"`, 1), `"error_code":null`, `"error_code":"34"`, 1)
	noSecret := conn(t, "messengernepal", map[string]string{"token": secretTok}, nil)
	rc, err = p.ParseCallback(noSecret, &Callback{Body: []byte(failed)})
	if err != nil || len(rc) != 1 || rc[0].Stat != "UNDELIV" || rc[0].Err != "34" {
		t.Fatalf("%+v %v", rc, err)
	}
	sent := strings.Replace(body, `"delivered"`, `"sent"`, 1)
	if rc, _ := p.ParseCallback(noSecret, &Callback{Body: []byte(sent)}); len(rc) != 1 || rc[0].Stat != "" {
		t.Fatalf("intermediate: %+v", rc)
	}
}

func TestNestSMS(t *testing.T) {
	c0 := conn(t, "nestsms", map[string]string{"token": secretTok}, nil)
	wantOutcome(t, send(t, "nestsms", c0, msg()), Rejected, "BAD_CONFIG")
	f := newFake(t, func(r rec) reply {
		switch {
		case r.Path == "/api/v1/sms/balance":
			return reply{body: `{"success":true,"data":{"balance":499.0}}`}
		case strings.HasPrefix(r.Path, "/api/v1/sms/status/"):
			id := strings.TrimPrefix(r.Path, "/api/v1/sms/status/")
			switch id {
			case "job-1":
				return reply{body: `{"success":true,"data":{"message_id":"job-1","status":"delivered","recipient":"9779841234567"}}`}
			case "job-2":
				return reply{body: `{"success":true,"data":{"status":"failed","error_code":"21","error_message":"absent"}}`}
			}
			return reply{status: 404, body: `{"success":false,"error":"not found","code":"MESSAGE_NOT_FOUND"}`}
		}
		if r.Header.Get("X-API-Key") != secretTok {
			return reply{status: 401, body: `{"success":false,"error":"bad key","code":"INVALID_API_KEY"}`}
		}
		return reply{status: 200, body: `{"success":true,"message":"SMS queued successfully","data":{"job_id":"job-1","cost":1.0,"remaining_balance":499.0}}`}
	})
	c := conn(t, "nestsms", map[string]string{"token": secretTok}, map[string]any{"base_url": f.srv.URL})
	r := send(t, "nestsms", c, msg())
	wantOutcome(t, r, Accepted, "")
	if r.ProviderID() != "job-1" || f.last(t).Path != "/api/v1/sms/send" {
		t.Fatalf("%+v", r)
	}
	bad := conn(t, "nestsms", map[string]string{"token": "other-key"}, map[string]any{"base_url": f.srv.URL})
	wantOutcome(t, send(t, "nestsms", bad, msg()), Rejected, "INVALID_API_KEY")
	rc, err := Get("nestsms").(DLRPoller).PollDLR(context.Background(), c, []Pending{{ProviderID: "job-1"}, {ProviderID: "job-2"}, {ProviderID: "job-3"}})
	if err != nil || len(rc) != 2 || rc[0].Stat != "DELIVRD" || rc[1].Stat != "UNDELIV" || rc[1].Err != "21" {
		t.Fatalf("poll %+v %v", rc, err)
	}
	if b := Get("nestsms").(BalanceChecker).Balance(context.Background(), c); b.Balance != "499.0" {
		t.Fatalf("balance %+v", b)
	}
}

// --- Twozero -------------------------------------------------------------------

func TestTwozero(t *testing.T) {
	f := newFake(t, func(r rec) reply {
		switch {
		case r.Path == "/api/v1/account/balance":
			return reply{body: `{"status":"success","data":{"credits":5000,"kyc_status":"approved","kyc_verified":true}}`}
		case strings.HasPrefix(r.Path, "/api/v1/sms/status/"):
			st := map[string]string{"msg_a": "delivered", "msg_b": "pending", "msg_c": "rejected"}[strings.TrimPrefix(r.Path, "/api/v1/sms/status/")]
			return reply{body: `{"status":"success","data":{"message_id":"x","status":"` + st + `","delivery_report":{"status":"` + st + `"}}}`}
		}
		if r.json(t)["to"] == "9800000003" {
			return reply{status: 400, body: `{"status":"error","message":"Insufficient credits","data":null}`}
		}
		return reply{body: `{"status":"success","message":"SMS sent successfully","data":{"message_id":"msg_abc123def456","to":"9841234567","credits_used":1,"status":"sent"}}`}
	})
	c := conn(t, "twozero", map[string]string{"token": secretTok}, map[string]any{"base_url": f.srv.URL + "/api/v1", "use_message_sender": true})
	r := send(t, "twozero", c, msg())
	wantOutcome(t, r, Accepted, "")
	req := f.last(t)
	if r.ProviderID() != "msg_abc123def456" || req.Path != "/api/v1/sms/send" || req.json(t)["sender_id"] != "ACME" || req.Header.Get("X-API-Key") != secretTok {
		t.Fatalf("%+v %+v", r, req)
	}
	m := msg()
	m.To = "9779800000003"
	wantOutcome(t, send(t, "twozero", c, m), Rejected, "INSUFFICIENT_CREDITS")
	rc, err := Get("twozero").(DLRPoller).PollDLR(context.Background(), c, []Pending{{ProviderID: "msg_a"}, {ProviderID: "msg_b"}, {ProviderID: "msg_c"}})
	if err != nil || len(rc) != 2 || rc[0].ProviderID != "msg_a" || rc[0].Stat != "DELIVRD" || rc[1].Stat != "REJECTD" {
		t.Fatalf("poll %+v %v", rc, err)
	}
	if b := Get("twozero").(BalanceChecker).Balance(context.Background(), c); b.Balance != "5000" {
		t.Fatalf("balance %+v", b)
	}
}

// --- Swift ---------------------------------------------------------------------

func TestSwift(t *testing.T) {
	f := newFake(t, func(r rec) reply {
		u, p, _ := (&http.Request{Header: r.Header}).BasicAuth()
		if u != "bank" || p != "s3cret-pass" || r.Header.Get("OrganisationCode") != "ORG42" {
			return reply{body: `{"responseCode":101,"responseDescription":"Invalid credentials"}`}
		}
		return reply{body: `{"responseCode":100,"responseDescription":"Success","messageId":98765}`}
	})
	c := conn(t, "swift_smartsms", map[string]string{"username": "bank", "password": "s3cret-pass", "organisation_code": "ORG42"},
		map[string]any{"base_url": f.srv.URL + "/api/Sms"})
	r := send(t, "swift_smartsms", c, msg())
	wantOutcome(t, r, Accepted, "")
	req := f.last(t)
	b := req.json(t)
	if r.ProviderID() != "98765" || req.Path != "/api/Sms/ExecuteSendSmsV5" || b["ReceiverNo"] != "+9779841234567" || b["IsClientLogin"] != "N" ||
		b["Message"] != "Hello नमस्ते" || len(b["Date"].(string)) != 19 {
		t.Fatalf("%+v %v", r, b)
	}
	bad := conn(t, "swift_smartsms", map[string]string{"username": "bank", "password": "wrong-pass", "organisation_code": "ORG42"},
		map[string]any{"base_url": f.srv.URL + "/api/Sms", "recipient_format": "local10"})
	r = send(t, "swift_smartsms", bad, msg())
	wantOutcome(t, r, Rejected, "SWIFT_101")
	if f.last(t).json(t)["ReceiverNo"] != "9841234567" {
		t.Fatal("recipient_format local10")
	}
	if strings.Contains(string(bad.MaskRequest(r.Exchange.Request).Header.Get("Authorization")), "Ym") {
		t.Fatal("basic auth not masked")
	}
	wantOutcome(t, send(t, "swift_smartsms", conn(t, "swift_smartsms", map[string]string{"username": "x"}, nil), msg()), Rejected, "BAD_CONFIG")
}

// --- Bullet / Bitmoro ------------------------------------------------------------

func TestBulletSMS(t *testing.T) {
	f := newFake(t, func(r rec) reply {
		if r.json(t)["to"].([]any)[0] == "9800000004" {
			return reply{status: 200, body: `{"success":false,"message":"Sender ID not approved"}`}
		}
		if r.json(t)["to"].([]any)[0] == "9800000005" {
			return reply{status: 422, body: `{"message":"invalid number"}`}
		}
		return reply{status: 201, body: `{"success":true,"data":{"messageId":"bsms-1","status":"queued"}}`}
	})
	c := conn(t, "bulletsms", map[string]string{"token": secretTok}, map[string]any{"base_url": f.srv.URL + "/api/v1", "sender": "BulletSMS"})
	r := send(t, "bulletsms", c, msg())
	wantOutcome(t, r, Accepted, "")
	req := f.last(t)
	if r.ProviderID() != "bsms-1" || req.Header.Get("Authorization") != "Bearer "+secretTok || req.json(t)["senderId"] != "BulletSMS" {
		t.Fatalf("%+v %+v", r, req)
	}
	m := msg()
	m.To = "9779800000004"
	wantOutcome(t, send(t, "bulletsms", c, m), Rejected, "PROVIDER_ERROR")
	m.To = "9779800000005"
	wantOutcome(t, send(t, "bulletsms", c, m), Rejected, "HTTP_422")
	rc, err := Get("bulletsms").(CallbackParser).ParseCallback(c, &Callback{Body: []byte(`{"event":"sms.delivered","messageId":"bsms-1","status":"delivered"}`)})
	if err != nil || len(rc) != 1 || rc[0].Stat != "DELIVRD" {
		t.Fatalf("%+v %v", rc, err)
	}
	rc, err = Get("bulletsms").(CallbackParser).ParseCallback(c, &Callback{Method: "GET", Query: map[string]any{"message_id": "bsms-2", "status": "failed"}})
	if err != nil || len(rc) != 1 || rc[0].ProviderID != "bsms-2" || rc[0].Stat != "UNDELIV" {
		t.Fatalf("query callback %+v %v", rc, err)
	}
}

func TestBitmoro(t *testing.T) {
	f := newFake(t, func(r rec) reply {
		if r.Path != "/message/api/bulk" {
			return reply{status: 404, body: `<!DOCTYPE html><html>404</html>`}
		}
		return reply{body: `{"status":"QUEUED","report":[{"to":"9841234567","messageId":"bm-77","text":"x","from":"BIT","type":2,"credit":1}],"creditSpent":1,"messageId":"batch-1","senderId":"BIT"}`}
	})
	c := conn(t, "bitmoro", map[string]string{"token": secretTok}, map[string]any{"base_url": f.srv.URL})
	m := msg()
	m.CallbackURL = "https://gw.example.com/v1/provider-dlr/dlrtok"
	r := send(t, "bitmoro", c, m)
	wantOutcome(t, r, Accepted, "")
	b := f.last(t).json(t)
	if r.ProviderID() != "bm-77" || b["callbackUrl"] != m.CallbackURL || b["number"].([]any)[0] != "9841234567" {
		t.Fatalf("%+v %v", r, b)
	}
	moved := conn(t, "bitmoro", map[string]string{"token": secretTok}, map[string]any{"base_url": f.srv.URL + "/old"})
	wantOutcome(t, send(t, "bitmoro", moved, msg()), Rejected, "HTTP_404")
	rc, err := Get("bitmoro").(CallbackParser).ParseCallback(c, &Callback{Body: []byte(`[{"messageId":"bm-77","status":"sent"},{"messageId":"bm-78","status":"failed"},{"messageId":"bm-79","status":"pending"}]`)})
	if err != nil || len(rc) != 3 || rc[0].Stat != "DELIVRD" || rc[1].Stat != "UNDELIV" || rc[2].Stat != "" {
		t.Fatalf("%+v %v", rc, err)
	}
}

// --- generic_http ----------------------------------------------------------------

func TestGenericHTTP(t *testing.T) {
	f := newFake(t, func(r rec) reply {
		if strings.Contains(r.Query, "fail=1") {
			return reply{body: `{"ok":false,"err":{"msg":"no route"}}`}
		}
		return reply{status: 200, body: `{"ok":true,"result":{"ids":["g-1"]}}`}
	})
	settings := map[string]any{
		"url":               f.srv.URL + "/send?acct={username}",
		"method":            "POST",
		"body_type":         "json",
		"params":            `{"auth":"{token}","dest":["{to}"],"local":"{to_local}","e164":"{to_e164}","msg":"{text}","from":"{sender}","ref":"{message_id}","n":5}`,
		"headers":           `{"X-Key":"{token}"}`,
		"recipient_format":  "msisdn",
		"success_json_path": "ok",
		"success_equals":    "true",
		"message_id_path":   "result.ids[0]",
		"error_path":        "err.msg",
	}
	c := conn(t, "generic_http", map[string]string{"token": secretTok, "username": "acc 1"}, settings)
	r := send(t, "generic_http", c, msg())
	wantOutcome(t, r, Accepted, "")
	req := f.last(t)
	b := req.json(t)
	if r.ProviderID() != "g-1" || req.Query != "acct=acc+1" || req.Header.Get("X-Key") != secretTok || b["auth"] != secretTok ||
		b["dest"].([]any)[0] != "9779841234567" || b["local"] != "9841234567" || b["e164"] != "+9779841234567" || b["msg"] != "Hello नमस्ते" ||
		b["from"] != "ACME" || b["ref"] != msg().ID || b["n"] != float64(5) {
		t.Fatalf("%+v %v", req, b)
	}
	masked := c.MaskRequest(r.Exchange.Request)
	if strings.Contains(string(masked.Body), secretTok) || masked.Header.Get("X-Key") != "***" {
		t.Fatalf("masking %s %v", masked.Body, masked.Header)
	}

	// GET with query parameters and a failing success rule.
	settings2 := map[string]any{"url": f.srv.URL + "/send", "method": "GET", "params": `{"token":"{token}","to":"{to}","text":"{text}","fail":"1"}`,
		"recipient_format": "local10", "success_json_path": "ok", "error_path": "err.msg"}
	c2 := conn(t, "generic_http", map[string]string{"token": secretTok}, settings2)
	r = send(t, "generic_http", c2, msg())
	wantOutcome(t, r, Rejected, "PROVIDER_ERROR")
	q, _ := url.ParseQuery(f.last(t).Query)
	if f.last(t).Method != "GET" || q.Get("to") != "9841234567" || q.Get("text") != "Hello नमस्ते" || !strings.Contains(r.Error, "no route") {
		t.Fatalf("GET %+v %v %s", f.last(t), q, r.Error)
	}
	// Form body + status rule.
	settings3 := map[string]any{"url": f.srv.URL + "/send", "params": `{"to":"{to}","t":"{text}"}`, "success_status": "201"}
	r = send(t, "generic_http", conn(t, "generic_http", nil, settings3), msg())
	wantOutcome(t, r, Retry, "HTTP_200") // 200 is outside the success list and not a 4xx: retried
	if f.last(t).form(t).Get("t") != "Hello नमस्ते" || f.last(t).Header.Get("Content-Type") != "application/x-www-form-urlencoded" {
		t.Fatalf("form %+v", f.last(t))
	}
	// params given as an object (api `json`-typed setting) works too.
	r = send(t, "generic_http", conn(t, "generic_http", nil, map[string]any{"url": f.srv.URL + "/send", "params": map[string]any{"to": "{to_local}"}}), msg())
	wantOutcome(t, r, Accepted, "")
	if f.last(t).form(t).Get("to") != "9841234567" {
		t.Fatalf("object params %+v", f.last(t))
	}
	wantOutcome(t, send(t, "generic_http", conn(t, "generic_http", nil, map[string]any{"url": "ftp://x/y", "params": `{}`}), msg()), Rejected, "BAD_CONFIG")
	wantOutcome(t, send(t, "generic_http", conn(t, "generic_http", nil, map[string]any{"url": f.srv.URL, "params": `[1]`}), msg()), Rejected, "BAD_CONFIG")
	if Get("generic_http").Info().DLRMode != DLRNone {
		t.Fatal("generic_http has no DLR")
	}
}

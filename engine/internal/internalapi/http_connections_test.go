package internalapi

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"

	"smsgw/engine/internal/dispatch"
	"smsgw/engine/internal/httpadapter"
)

type fakeHTTPConns struct {
	known string
	cb    *httpadapter.Callback
	to    string
}

func (f *fakeHTTPConns) TestSend(_ context.Context, id, to, text, _ string) (*dispatch.TestResult, error) {
	if id != f.known {
		return nil, dispatch.ErrConnectionNotFound
	}
	f.to = to
	pid := "p-1"
	return &dispatch.TestResult{OK: true, ProviderMessageID: &pid, HTTPStatus: 200,
		Request: &dispatch.TestRequest{Method: "POST", URL: "https://p/x", Body: "token=***&to=" + to}, ResponseBody: "{}", DurationMS: 5}, nil
}

func (f *fakeHTTPConns) ProviderBalance(_ context.Context, id string) (*dispatch.BalanceResult, error) {
	if id != f.known {
		return nil, dispatch.ErrConnectionNotFound
	}
	b := "1520"
	return &dispatch.BalanceResult{Supported: true, Balance: &b, Raw: `{"credits_available":1520}`}, nil
}

func (f *fakeHTTPConns) ProviderDLR(_ context.Context, tok string, cb *httpadapter.Callback) (int, error) {
	switch tok {
	case "good-token":
		f.cb = cb
		return 2, nil
	case "badsig-token":
		return 0, httpadapter.ErrBadSignature
	}
	return 0, dispatch.ErrConnectionNotFound
}

func TestHTTPConnectionEndpoints(t *testing.T) {
	a, _, _, _ := newAPI()
	f := &fakeHTTPConns{known: uuid.NewString()}
	a.d.HTTPConns = f

	st, b := do(t, a, "GET", "/internal/v1/adapters", "", token)
	ads, _ := b["adapters"].([]any)
	if st != 200 || len(ads) != 11 {
		t.Fatalf("%d %v", st, b)
	}
	first := ads[0].(map[string]any)
	for _, k := range []string{"id", "name", "country", "website", "docs_url", "confidence", "credentials", "settings", "dlr_mode", "supports_balance", "destination_countries", "notes"} {
		if _, ok := first[k]; !ok {
			t.Fatalf("catalogue entry lacks %q: %v", k, first)
		}
	}
	if first["id"] != "sparrow_v2" || first["dlr_mode"] != "none" {
		t.Fatalf("%v", first)
	}
	cred := first["credentials"].([]any)[0].(map[string]any)
	for _, k := range []string{"key", "label", "secret", "required", "placeholder", "help"} {
		if _, ok := cred[k]; !ok {
			t.Fatalf("credential lacks %q", k)
		}
	}
	if st, _ := do(t, a, "GET", "/internal/v1/adapters", "", ""); st != 401 {
		t.Fatal("catalogue without token")
	}

	st, b = do(t, a, "POST", "/internal/v1/connections/"+f.known+"/test", `{"to":"9841234567","text":"hi"}`, token)
	if st != 200 || b["ok"] != true || b["provider_message_id"] != "p-1" || b["request"].(map[string]any)["method"] != "POST" || f.to != "9841234567" {
		t.Fatalf("%d %v", st, b)
	}
	if st, b = do(t, a, "POST", "/internal/v1/connections/"+uuid.NewString()+"/test", `{"to":"9841234567","text":"hi"}`, token); st != 404 {
		t.Fatalf("%d %v", st, b)
	}
	if st, _ = do(t, a, "POST", "/internal/v1/connections/"+f.known+"/test", `{"to":""}`, token); st != 400 {
		t.Fatalf("%d", st)
	}
	st, b = do(t, a, "GET", "/internal/v1/connections/"+f.known+"/balance", "", token)
	if st != 200 || b["supported"] != true || b["balance"] != "1520" {
		t.Fatalf("%d %v", st, b)
	}

	body := base64.StdEncoding.EncodeToString([]byte(`{"status":"delivered"}`))
	fwd := `{"method":"POST","query":{"a":"1"},"headers":{"X-Msngr-Signature":"sha256=ab"},"body_base64":"` + body + `"}`
	st, b = do(t, a, "POST", "/internal/v1/provider-dlr/good-token", fwd, token)
	if st != 200 || b["accepted"].(float64) != 2 || string(f.cb.Body) != `{"status":"delivered"}` || f.cb.Headers["x-msngr-signature"] != "sha256=ab" || f.cb.QueryValue("a") != "1" {
		t.Fatalf("%d %v %+v", st, b, f.cb)
	}
	if st, b = do(t, a, "POST", "/internal/v1/provider-dlr/unknown", fwd, token); st != 404 {
		t.Fatalf("%d %v", st, b)
	}
	if st, b = do(t, a, "POST", "/internal/v1/provider-dlr/badsig-token", fwd, token); st != 403 {
		t.Fatalf("%d %v", st, b)
	}
	// GET without a body: the request's own query string.
	req := httptest.NewRequest("GET", "/internal/v1/provider-dlr/good-token?messageId=x1&status=delivered", nil)
	req.Header.Set("X-Internal-Token", token)
	rec := httptest.NewRecorder()
	a.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || f.cb.Method != "GET" || f.cb.QueryValue("messageId") != "x1" || !strings.Contains(rec.Body.String(), `"accepted":2`) {
		t.Fatalf("%d %s %+v", rec.Code, rec.Body.String(), f.cb)
	}
}

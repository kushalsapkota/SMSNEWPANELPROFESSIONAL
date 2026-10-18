package internalapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"smsgw/engine/internal/dispatch"
	"smsgw/engine/internal/httpadapter"
	"smsgw/engine/internal/policy"
)

// GET /internal/v1/adapters: the HTTP adapter catalogue.
func (a *API) adapters(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"adapters": httpadapter.Catalogue()})
}

func (a *API) httpConns(w http.ResponseWriter, r *http.Request) (HTTPConnections, bool) {
	if a.d.HTTPConns == nil {
		writeError(w, policy.New(policy.CodeInternal, "http connections not available"))
		return nil, false
	}
	return a.d.HTTPConns, true
}

func connError(err error) error {
	if errors.Is(err, dispatch.ErrConnectionNotFound) {
		return policy.New(policy.CodeNotFound, "connection not found")
	}
	return policy.Wrap(policy.CodeInternal, "request failed", err)
}

// POST /internal/v1/connections/:id/test {to, text, from?}: one real
// message outside billing / CDR. from (optional) is the message's sender.
func (a *API) testSend(w http.ResponseWriter, r *http.Request) {
	hc, ok := a.httpConns(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	if uuid.Validate(id) != nil {
		a.fail(w, r, policy.New(policy.CodeInvalidRequest, "connection id must be a uuid"))
		return
	}
	var b struct {
		To   string `json:"to"`
		Text string `json:"text"`
		From string `json:"from"`
	}
	if err := decode(r, &b); err != nil {
		a.fail(w, r, err)
		return
	}
	if strings.TrimSpace(b.To) == "" || b.Text == "" {
		a.fail(w, r, policy.New(policy.CodeInvalidRequest, "to and text are required"))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	res, err := hc.TestSend(ctx, id, b.To, b.Text, strings.TrimSpace(b.From))
	if err != nil {
		a.fail(w, r, connError(err))
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// GET /internal/v1/connections/:id/balance.
func (a *API) providerBalance(w http.ResponseWriter, r *http.Request) {
	hc, ok := a.httpConns(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	if uuid.Validate(id) != nil {
		a.fail(w, r, policy.New(policy.CodeInvalidRequest, "connection id must be a uuid"))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	res, err := hc.ProviderBalance(ctx, id)
	if err != nil {
		a.fail(w, r, connError(err))
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// providerCallback is the api's verbatim forward of a provider callback.
type providerCallback struct {
	Method     string            `json:"method"`
	Query      map[string]any    `json:"query"`
	Headers    map[string]string `json:"headers"`
	BodyBase64 string            `json:"body_base64"`
}

// POST|GET /internal/v1/provider-dlr/:token → {"accepted": n} (404 for an
// unknown token, 403 for a bad signature, 400 for an unreadable callback).
// The body is the api's forward {method, query, headers, body_base64}; a
// request without a body (GET) is read as a direct callback: its own query
// string and headers, empty body.
func (a *API) providerDLR(w http.ResponseWriter, r *http.Request) {
	hc, ok := a.httpConns(w, r)
	if !ok {
		return
	}
	token := r.PathValue("token")
	if token == "" || len(token) > 256 {
		a.fail(w, r, policy.New(policy.CodeNotFound, "unknown DLR token"))
		return
	}
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		a.fail(w, r, policy.New(policy.CodeInvalidRequest, "cannot read request body"))
		return
	}
	cb := &httpadapter.Callback{Method: r.Method, Query: map[string]any{}, Headers: map[string]string{}}
	if len(strings.TrimSpace(string(raw))) > 0 {
		var fwd providerCallback
		if err := json.Unmarshal(raw, &fwd); err != nil {
			a.fail(w, r, policy.Errorf(policy.CodeInvalidRequest, "invalid JSON: %v", err))
			return
		}
		body, err := base64.StdEncoding.DecodeString(fwd.BodyBase64)
		if err != nil {
			a.fail(w, r, policy.New(policy.CodeInvalidRequest, "body_base64 is not valid base64"))
			return
		}
		cb.Method, cb.Body = strings.ToUpper(fwd.Method), body
		if fwd.Query != nil {
			cb.Query = fwd.Query
		}
		for k, v := range fwd.Headers {
			cb.Headers[strings.ToLower(k)] = v
		}
	} else {
		for k, vs := range r.URL.Query() {
			if len(vs) == 1 {
				cb.Query[k] = vs[0]
			} else {
				l := make([]any, len(vs))
				for i, v := range vs {
					l[i] = v
				}
				cb.Query[k] = l
			}
		}
		for k := range r.Header {
			cb.Headers[strings.ToLower(k)] = r.Header.Get(k)
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	n, err := hc.ProviderDLR(ctx, token, cb)
	switch {
	case errors.Is(err, dispatch.ErrConnectionNotFound):
		a.fail(w, r, policy.New(policy.CodeNotFound, "unknown DLR token"))
		return
	case errors.Is(err, httpadapter.ErrBadSignature):
		a.fail(w, r, policy.New(policy.CodeForbidden, "callback signature does not verify"))
		return
	case err != nil:
		a.fail(w, r, policy.New(policy.CodeInvalidRequest, "callback not understood: "+err.Error()))
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"accepted": n})
}

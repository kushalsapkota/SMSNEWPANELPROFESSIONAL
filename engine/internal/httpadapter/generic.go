package httpadapter

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// generic is a configurable adapter for providers without a built-in one:
// method, URL template, body type (query / form / json), a params template
// (JSON object) and optional headers template with placeholders {to}
// {to_local} {to_e164} {text} {sender} {message_id} and any credential key
// ({token} {username} {password}); success = HTTP status in a list plus an
// optional JSON path equality and/or body regex; message id from a JSON
// path. No delivery reports (messages end as NODLR).
type generic struct{}

func init() { register(generic{}) }

func (generic) Info() Info {
	return Info{
		ID: "generic_http", Name: "Generic HTTP API", Country: "", Website: "", DocsURL: nil, Confidence: ConfidenceVerified,
		Credentials: []Credential{
			{Key: "token", Label: "Token / API key", Secret: true, Help: "Available as {token}."},
			{Key: "username", Label: "Username", Secret: false, Help: "Available as {username}."},
			{Key: "password", Label: "Password", Secret: true, Help: "Available as {password}."},
		},
		Settings: []Setting{
			{Key: "url", Label: "Request URL", Type: TypeURL, Required: true,
				Help: "http(s) URL; placeholders are allowed and URL-encoded, e.g. https://api.example.com/sms/send"},
			{Key: "method", Label: "HTTP method", Type: TypeSelect, Default: "POST", Options: []string{"POST", "GET"}},
			{Key: "body_type", Label: "Parameters sent as", Type: TypeSelect, Default: "form", Options: []string{"query", "form", "json"},
				Help: "query = URL query string, form = application/x-www-form-urlencoded, json = JSON body. GET always uses the query string."},
			{Key: "params", Label: "Parameters template (JSON object)", Type: TypeString, Required: true,
				Default: `{"token":"{token}","to":"{to}","text":"{text}","from":"{sender}"}`,
				Help:    "Placeholders: {to} {to_local} {to_e164} {text} {sender} {message_id} {token} {username} {password}."},
			{Key: "headers", Label: "Extra headers (JSON object)", Type: TypeString,
				Help: `Optional, e.g. {"Authorization":"Bearer {token}"}.`},
			{Key: "recipient_format", Label: "{to} format", Type: TypeSelect, Default: "msisdn",
				Options: []string{"msisdn", "e164", "local10", "national"},
				Help:    "msisdn = 9779841234567, e164 = +9779841234567, local10 = 9841234567 (Nepal), national = without country code."},
			{Key: "sender", Label: "Sender ID", Type: TypeString, Help: "{sender}; blank = the message's sender."},
			{Key: "success_status", Label: "Success HTTP statuses", Type: TypeString, Default: "200,201,202",
				Help: "Comma separated. Other 4xx are rejections; 408, 429 and 5xx are retried."},
			{Key: "success_json_path", Label: "Success JSON path", Type: TypeString,
				Help: "Optional, e.g. status or data.error. With Success value: must equal it; without: must be present and not false/0/empty."},
			{Key: "success_equals", Label: "Success value", Type: TypeString, Help: "Compared as text, e.g. success, true, 0."},
			{Key: "success_regex", Label: "Success body regex", Type: TypeString, Help: "Optional RE2 regex the response body must match."},
			{Key: "message_id_path", Label: "Message id JSON path", Type: TypeString, Help: "Optional, e.g. data.message_id or messages[0].id."},
			{Key: "error_path", Label: "Error message JSON path", Type: TypeString, Help: "Optional, e.g. error.message."},
			maxConcurrencySetting(),
		},
		DLRMode: DLRNone, SupportsBalance: false, DestinationCountries: nil,
		Notes: "For providers without a built-in adapter. Delivery reports are not collected (messages show 'Sent (provider gives no delivery report)'). " +
			"Use 'Send test SMS' to check the success rule against the real response.",
	}
}

var placeholderRe = regexp.MustCompile(`\{([a-z0-9_]+)\}`)

func (c *Conn) genericVars(m *Message) map[string]string {
	vars := map[string]string{}
	for k, v := range c.Credentials {
		vars[k] = v
	}
	sender := c.Settings.Str("sender", "")
	if sender == "" {
		sender = m.Source
	}
	vars["to"] = FormatRecipient(m.To, c.Settings.Str("recipient_format", "msisdn"))
	vars["to_local"] = FormatRecipient(m.To, "local10")
	vars["to_e164"] = "+" + digits(m.To)
	vars["text"] = m.Text
	vars["sender"] = sender
	vars["message_id"] = m.ID
	return vars
}

func render(s string, vars map[string]string, esc func(string) string) string {
	return placeholderRe.ReplaceAllStringFunc(s, func(p string) string {
		v, ok := vars[p[1:len(p)-1]]
		if !ok {
			return p
		}
		if esc != nil {
			return esc(v)
		}
		return v
	})
}

func renderAny(v any, vars map[string]string) any {
	switch x := v.(type) {
	case string:
		return render(x, vars, nil)
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, e := range x {
			out[k] = renderAny(e, vars)
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = renderAny(e, vars)
		}
		return out
	}
	return v
}

// objectSetting reads a JSON-object setting given either as JSON text or
// as an object.
func (c *Conn) objectSetting(key string) (map[string]any, error) {
	if obj, ok := c.Settings[key].(map[string]any); ok {
		return obj, nil
	}
	return parseObjectTemplate(c.Settings.Str(key, ""), key)
}

func parseObjectTemplate(s, what string) (map[string]any, error) {
	if strings.TrimSpace(s) == "" {
		return map[string]any{}, nil
	}
	v, ok := parseJSON([]byte(s))
	obj, isObj := v.(map[string]any)
	if !ok || !isObj {
		return nil, fmt.Errorf("%s must be a JSON object", what)
	}
	return obj, nil
}

func badConfig(format string, a ...any) SendResult {
	return SendResult{Outcome: Rejected, ErrorCode: "BAD_CONFIG", Error: fmt.Sprintf(format, a...)}
}

func (generic) buildRequest(c *Conn, m *Message) (*Request, error) {
	vars := c.genericVars(m)
	rawURL := render(c.Settings.Str("url", ""), vars, url.QueryEscape)
	u, err := url.Parse(rawURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, fmt.Errorf("url must be an http(s) URL")
	}
	params, err := c.objectSetting("params")
	if err != nil {
		return nil, err
	}
	headers, err := c.objectSetting("headers")
	if err != nil {
		return nil, err
	}
	h := http.Header{"Accept": {"application/json, */*"}}
	for k, v := range headers {
		h.Set(k, render(jstrOrJSON(v), vars, nil))
	}
	method := strings.ToUpper(c.Settings.Str("method", "POST"))
	if method != http.MethodGet && method != http.MethodPost {
		return nil, fmt.Errorf("method must be GET or POST")
	}
	bodyType := strings.ToLower(c.Settings.Str("body_type", "form"))
	if method == http.MethodGet {
		bodyType = "query"
	}
	rendered := renderAny(params, vars).(map[string]any)
	values := url.Values{}
	for k, v := range rendered {
		values.Set(k, jstrOrJSON(v))
	}
	req := &Request{Method: method, URL: u.String(), Header: h}
	switch bodyType {
	case "query":
		if len(values) > 0 {
			q := u.Query()
			for k := range values {
				q.Set(k, values.Get(k))
			}
			u.RawQuery = q.Encode()
			req.URL = u.String()
		}
		if method == http.MethodPost {
			req.Body = []byte{}
		}
	case "form":
		req.Body = []byte(values.Encode())
		if h.Get("Content-Type") == "" {
			h.Set("Content-Type", "application/x-www-form-urlencoded")
		}
	case "json":
		b, err := marshalJSON(rendered)
		if err != nil {
			return nil, err
		}
		req.Body = b
		if h.Get("Content-Type") == "" {
			h.Set("Content-Type", "application/json")
		}
	default:
		return nil, fmt.Errorf("body_type must be query, form or json")
	}
	return req, nil
}

// jstrOrJSON renders scalars as text and objects / arrays as JSON.
func jstrOrJSON(v any) string {
	if s := jstr(v); s != "" || v == nil {
		return s
	}
	if _, isStr := v.(string); isStr {
		return ""
	}
	b, _ := json.Marshal(v)
	return string(b)
}

func (g generic) Send(ctx context.Context, c *Conn, m *Message) SendResult {
	req, err := g.buildRequest(c, m)
	if err != nil {
		return badConfig("generic_http: %v", err)
	}
	okStatus := map[int]bool{}
	for _, f := range strings.Split(c.Settings.Str("success_status", "200,201,202"), ",") {
		if n, err := strconv.Atoi(strings.TrimSpace(f)); err == nil {
			okStatus[n] = true
		}
	}
	var re *regexp.Regexp
	if p := c.Settings.Str("success_regex", ""); p != "" {
		if re, err = regexp.Compile(p); err != nil {
			return badConfig("generic_http: success_regex: %v", err)
		}
	}
	resp, res, handled := c.exchange(ctx, req)
	if handled {
		return res
	}
	v, isJSON := parseJSON(resp.Body)
	errMsg := ""
	if p := c.Settings.Str("error_path", ""); p != "" && isJSON {
		errMsg = jstrOrJSON(jpath(v, p))
	}
	if !okStatus[resp.Status] {
		return c.rejectHTTP(res, resp, errMsg)
	}
	if path := c.Settings.Str("success_json_path", ""); path != "" {
		if !isJSON {
			return c.unparseable(res, resp)
		}
		got := jpath(v, path)
		want, hasWant := c.Settings["success_equals"]
		ok := false
		if hasWant && fmt.Sprint(want) != "" {
			ok = strings.EqualFold(jstrOrJSON(got), c.Settings.Str("success_equals", ""))
		} else {
			s := jstrOrJSON(got)
			ok = got != nil && s != "" && s != "false" && s != "0"
		}
		if !ok {
			res.Outcome, res.ErrorCode = Rejected, "PROVIDER_ERROR"
			if errMsg == "" {
				errMsg = fmt.Sprintf("%s = %q", path, jstrOrJSON(got))
			}
			res.Error = c.Mask("provider rejected the message: " + errMsg)
			return res
		}
	}
	if re != nil && !re.Match(resp.Body) {
		res.Outcome, res.ErrorCode = Rejected, "PROVIDER_ERROR"
		res.Error = c.Mask("response does not match success_regex: " + snippet(resp.Body, 200))
		return res
	}
	res.Outcome = Accepted
	if p := c.Settings.Str("message_id_path", ""); p != "" && isJSON {
		if id := jstr(jpath(v, p)); id != "" {
			res.ProviderIDs = []string{id}
		}
	}
	return res
}

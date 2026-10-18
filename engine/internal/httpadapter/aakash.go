package httpadapter

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// Aakash SMS (VERIFIED: aakashsms.com/documentation and the official
// Bitbucket README, v4 branch; live-probed 2026-10-18).
//
// v3: POST {base}/v3/send form auth_token, to, text. HTTP 200 even on
// errors: success is "error": false. data.valid[] (queued, with integer id)
// and data.invalid[] (aborted) report each recipient, so one number can be
// accepted while another is rejected.
//
// v4: POST {base}/v4/send-user, header auth-token, JSON {"to":[...],
// "text":[...]}; {"responses":[{error,message,data:{valid,invalid}}],
// "errors":[]} or {"error":true,"message":...,"errors":[...]}; ids are
// strings.
//
// DLR (both): poll the paged report list POST {base}/v1/report/api (form
// auth_token, page). Records have id and delivery_at only; a non-empty
// delivery_at is the only delivery signal (no failure status exists).
//
// Balance: v3 POST {base}/v1/credit (form) → available_credit;
// v4 GET {base}/v4/available-credit (header auth-token).
type aakashV3 struct{}
type aakashV4 struct{}

func init() {
	register(aakashV3{})
	register(aakashV4{})
}

const aakashBase = "https://sms.aakashsms.com/sms"

func aakashInfo(id, name, docs, notes string) Info {
	return Info{
		ID: id, Name: name, Country: "NP", Website: "https://aakashsms.com", DocsURL: strp(docs), Confidence: ConfidenceVerified,
		Credentials: []Credential{tokenCred("Auth token", "", "Generated in the Aakash SMS dashboard.")},
		Settings: append([]Setting{baseURLSetting(aakashBase, "Override only if Aakash gives you another endpoint.", false), maxConcurrencySetting()},
			pollSettings(10)...),
		DLRMode: DLRPoll, SupportsBalance: true, DestinationCountries: []string{"NP"}, Notes: notes,
	}
}

func (aakashV3) Info() Info {
	return aakashInfo("aakash_v3", "Aakash SMS (v3)", "https://aakashsms.com/documentation/",
		"Answers HTTP 200 even on errors (the gateway checks error=false). No sender parameter: the sender is fixed per Aakash account. "+
			"Delivery is read from Aakash's report list (only 'delivered' is reported; failures are not). "+
			"For dlr_poll_batch, one unit is one report page.")
}

func (aakashV4) Info() Info {
	return aakashInfo("aakash_v4", "Aakash SMS (v4, JSON)", "https://bitbucket.org/aakashsms/api/src/v4/README.md",
		"JSON API with string message ids. No sender parameter: the sender is fixed per Aakash account. "+
			"Delivery is read from Aakash's report list (only 'delivered' is reported; failures are not). "+
			"For dlr_poll_batch, one unit is one report page.")
}

// aakashErrorCode maps Aakash's error messages (no numeric codes exist).
func aakashErrorCode(msg string) (code string, recipient bool) {
	m := strings.ToLower(msg)
	switch {
	case strings.Contains(m, "balance"):
		return "INSUFFICIENT_BALANCE", false
	case strings.Contains(m, "token"):
		return "INVALID_TOKEN", false
	case strings.Contains(m, "no valid recipient"), strings.Contains(m, "to field"), strings.Contains(m, "invalid"):
		return "INVALID_RECIPIENT", true
	case strings.Contains(m, "text field"):
		return "EMPTY_TEXT", true
	}
	return "PROVIDER_ERROR", false
}

// aakashData interprets one {error,message,data:{valid,invalid}} block.
func (c *Conn) aakashData(res SendResult, block any) SendResult {
	valid, _ := jpath(block, "data.valid").([]any)
	invalid, _ := jpath(block, "data.invalid").([]any)
	for _, x := range valid {
		if id := jstr(jpath(x, "id")); id != "" {
			res.ProviderIDs = append(res.ProviderIDs, id)
		}
	}
	if len(valid) > 0 {
		res.Outcome = Accepted
		if len(res.ProviderIDs) == 0 {
			// Queued but without an id: accepted, no DLR possible.
			res.ProviderIDs = nil
		}
		return res
	}
	if len(invalid) > 0 {
		st := jstr(jpath(invalid[0], "status"))
		res.Outcome, res.ErrorCode, res.RecipientError = Rejected, "INVALID_RECIPIENT", true
		res.Error = c.Mask(fmt.Sprintf("Aakash rejected the number (%s, network %s)", st, jstr(jpath(invalid[0], "network"))))
		return res
	}
	res.Outcome, res.ErrorCode = Unknown, "SUBMIT_UNKNOWN"
	res.Error = c.Mask("Aakash answered without valid/invalid recipients: " + jstr(jpath(block, "message")))
	return res
}

func (aakashV3) Send(ctx context.Context, c *Conn, m *Message) SendResult {
	if r := requireCreds(c, "token"); r != nil {
		return *r
	}
	to, r := requireNP(m)
	if r != nil {
		return *r
	}
	form := url.Values{"auth_token": {c.Cred("token")}, "to": {to}, "text": {m.Text}}
	resp, res, handled := c.exchange(ctx, formRequest(c.baseURL(aakashBase)+"/v3/send", form))
	if handled {
		return res
	}
	v, ok := parseJSON(resp.Body)
	isErr, hasErr := jbool(jpath(v, "error"))
	if !ok || !hasErr {
		if resp.Status/100 == 2 {
			return c.unparseable(res, resp)
		}
		return c.rejectHTTP(res, resp, "")
	}
	if isErr {
		msg := jstr(jpath(v, "message"))
		res.Outcome = Rejected
		res.ErrorCode, res.RecipientError = aakashErrorCode(msg)
		res.Error = c.Mask("Aakash error: " + msg)
		return res
	}
	if resp.Status/100 != 2 {
		return c.rejectHTTP(res, resp, jstr(jpath(v, "message")))
	}
	return c.aakashData(res, v)
}

func (aakashV4) Send(ctx context.Context, c *Conn, m *Message) SendResult {
	if r := requireCreds(c, "token"); r != nil {
		return *r
	}
	to, r := requireNP(m)
	if r != nil {
		return *r
	}
	req, err := jsonRequest(http.MethodPost, c.baseURL(aakashBase)+"/v4/send-user",
		map[string]any{"to": []string{to}, "text": []string{m.Text}}, hdr("auth-token", c.Cred("token")))
	if err != nil {
		return SendResult{Outcome: Rejected, ErrorCode: "ENCODING_ERROR", Error: err.Error()}
	}
	resp, res, handled := c.exchange(ctx, req)
	if handled {
		return res
	}
	v, ok := parseJSON(resp.Body)
	if !ok {
		if resp.Status/100 == 2 {
			return c.unparseable(res, resp)
		}
		return c.rejectHTTP(res, resp, "")
	}
	if isErr, _ := jbool(jpath(v, "error")); isErr {
		msg := jfirst(v, "errors[0].message", "message")
		res.Outcome = Rejected
		res.ErrorCode, res.RecipientError = aakashErrorCode(msg)
		res.Error = c.Mask("Aakash error: " + jstr(jpath(v, "message")) + " " + jstr(jpath(v, "errors[0].message")))
		return res
	}
	if resp.Status/100 != 2 {
		return c.rejectHTTP(res, resp, jstr(jpath(v, "message")))
	}
	responses, _ := jpath(v, "responses").([]any)
	if len(responses) == 0 {
		if errs, _ := jpath(v, "errors").([]any); len(errs) > 0 {
			msg := jstr(jpath(errs[0], "message"))
			res.Outcome = Rejected
			res.ErrorCode, res.RecipientError = aakashErrorCode(msg)
			res.Error = c.Mask("Aakash error: " + msg)
			return res
		}
		return c.unparseable(res, resp)
	}
	block := responses[0]
	if isErr, _ := jbool(jpath(block, "error")); isErr {
		msg := jstr(jpath(block, "message"))
		res.Outcome = Rejected
		res.ErrorCode, res.RecipientError = aakashErrorCode(msg)
		res.Error = c.Mask("Aakash error: " + msg)
		return res
	}
	return c.aakashData(res, block)
}

// aakashPoll walks the v1 report list (newest pages are unknown, so pages
// are read from 1 up to dlr_poll_batch / total_page) and reports every
// pending id that has a delivery_at.
func aakashPoll(ctx context.Context, c *Conn, pending []Pending) ([]Receipt, error) {
	want := map[string]bool{}
	for _, p := range pending {
		if p.ProviderID != "" {
			want[p.ProviderID] = true
		}
	}
	if len(want) == 0 {
		return nil, nil
	}
	maxPages := c.Settings.Int("dlr_poll_batch", 10)
	if maxPages < 1 {
		maxPages = 1
	}
	var out []Receipt
	for page := 1; page <= maxPages && len(want) > 0; page++ {
		form := url.Values{"auth_token": {c.Cred("token")}, "page": {strconv.Itoa(page)}}
		resp, _, err := c.do(ctx, formRequest(c.baseURL(aakashBase)+"/v1/report/api", form))
		if err != nil {
			return out, fmt.Errorf("aakash report: %s", c.Mask(err.Error()))
		}
		v, ok := parseJSON(resp.Body)
		if !ok || resp.Status/100 != 2 {
			return out, fmt.Errorf("aakash report: HTTP %d: %s", resp.Status, c.Mask(snippet(resp.Body, 200)))
		}
		if isErr, _ := jbool(jpath(v, "error")); isErr {
			return out, fmt.Errorf("aakash report: %s", c.Mask(jstr(jpath(v, "message"))))
		}
		recs, _ := jpath(v, "data").([]any)
		for _, r := range recs {
			id := jstr(jpath(r, "id"))
			if !want[id] {
				continue
			}
			if at := strings.TrimSpace(jstr(jpath(r, "delivery_at"))); at != "" {
				out = append(out, Receipt{ProviderID: id, Stat: "DELIVRD", Raw: "delivery_at=" + at})
				delete(want, id)
			}
		}
		total, err := strconv.Atoi(jstr(jpath(v, "total_page")))
		if err != nil || page >= total || len(recs) == 0 {
			break
		}
	}
	return out, nil
}

func (aakashV3) PollDLR(ctx context.Context, c *Conn, p []Pending) ([]Receipt, error) {
	return aakashPoll(ctx, c, p)
}

func (aakashV4) PollDLR(ctx context.Context, c *Conn, p []Pending) ([]Receipt, error) {
	return aakashPoll(ctx, c, p)
}

func aakashBalanceOK(code string) func(any, *Response) (bool, string) {
	return func(v any, resp *Response) (bool, string) {
		if isErr, _ := jbool(jpath(v, "error")); isErr || resp.Status/100 != 2 {
			return false, fmt.Sprintf("HTTP %d: %s", resp.Status, jstr(jpath(v, "message")))
		}
		if rc := jstr(jpath(v, "response_code")); rc != "" && rc != code && rc != "200" {
			return false, "response_code " + rc
		}
		return true, ""
	}
}

func (aakashV3) Balance(ctx context.Context, c *Conn) BalanceResult {
	req := formRequest(c.baseURL(aakashBase)+"/v1/credit", url.Values{"auth_token": {c.Cred("token")}})
	return balanceCall(ctx, c, req, aakashBalanceOK("202"), "available_credit")
}

func (aakashV4) Balance(ctx context.Context, c *Conn) BalanceResult {
	req := getRequest(c.baseURL(aakashBase)+"/v4/available-credit", nil, hdr("auth-token", c.Cred("token")))
	return balanceCall(ctx, c, req, aakashBalanceOK("200"), "available_credit")
}

// PollPending: the report list is paged, so many pending ids are matched
// per poll (dlr_poll_batch bounds the pages instead).
func (aakashV3) PollPending() int { return 1000 }

// PollPending: see aakashV3.
func (aakashV4) PollPending() int { return 1000 }

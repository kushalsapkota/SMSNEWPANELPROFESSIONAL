package httpadapter

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// MessengerNepal (VERIFIED, OpenAPI 3 at api.messengernepal.com.np) and
// Nest SMS (LIKELY: same white-label platform, production host unknown).
//
// Send: POST {base}/sms/send (account default sender) or
// {base}/sms/send/with-sender-id (sender_id), header X-API-Key, optional
// Idempotency-Key (our message id: retries are safe), JSON {to, message,
// sender_id?, message_type?}. Success HTTP 202 (Nest: 200/202)
// {"success":true,"data":{"message_id"|"job_id",...}}; errors
// {"success":false,"error":"...","code":"INSUFFICIENT_CREDITS"|...}.
//
// MessengerNepal DLR: signed webhooks configured in its dashboard
// (X-Msngr-Signature: sha256=hex(HMAC-SHA256(secret, ts + "." + rawBody)))
// with data.message_id and data.status. Nest DLR: poll GET
// {base}/api/v1/sms/status/{id}. Balance: MessengerNepal none (only
// remaining_credits in send responses); Nest GET {base}/api/v1/sms/balance.
type messengerNepal struct{}
type nestSMS struct{}

func init() {
	register(messengerNepal{})
	register(nestSMS{})
}

const msnpBase = "https://api.messengernepal.com.np/api/v1"

// msnpRecipientCodes are message-level error codes of the platform.
var msnpRecipientCodes = map[string]bool{"MISSING_TO": true, "INVALID_TO_FORMAT": true, "MESSAGE_TOO_LONG": true,
	"VALIDATION_ERROR": true, "INVALID_RECIPIENT": true}

func messageTypeSetting() Setting {
	return Setting{Key: "message_type", Label: "Message type", Type: TypeSelect, Default: "transactional",
		Options: []string{"transactional", "promotional", "otp"}, Help: "Sent as message_type."}
}

func (messengerNepal) Info() Info {
	return Info{
		ID: "messengernepal", Name: "MessengerNepal", Country: "NP", Website: "https://messengernepal.com.np",
		DocsURL: strp("https://messengernepal.com.np/docs"), Confidence: ConfidenceVerified,
		Credentials: []Credential{
			tokenCred("API key", "msnp_live_...", "msnp_live_... (msnp_test_... keys never reach handsets)."),
			{Key: "webhook_secret", Label: "Webhook signing secret", Secret: true, Required: false,
				Help: "From MessengerNepal > API Integration > Webhooks. When set, delivery webhooks must carry a valid X-Msngr-Signature."},
		},
		Settings: append(append([]Setting{baseURLSetting(msnpBase, "Override only if MessengerNepal gives you another endpoint.", false)},
			senderSettings("Approved sender ID (GET /sms/sender-ids). Blank = the account's default sender.")...),
			messageTypeSetting(), maxConcurrencySetting()),
		DLRMode: DLRCallback, SupportsBalance: false, DestinationCountries: []string{"NP"},
		Notes: "Delivery reports arrive as signed webhooks: add the DLR callback URL shown here as a webhook in the MessengerNepal dashboard " +
			"(events sms.delivered, sms.failed). Live keys need KYC and live-API approval. No balance endpoint.",
	}
}

func (nestSMS) Info() Info {
	return Info{
		ID: "nestsms", Name: "Nest SMS", Country: "NP", Website: "https://nestsms.com",
		DocsURL: strp("https://nestsms.com/docs"), Confidence: ConfidenceLikely,
		Credentials: []Credential{tokenCred("API key", "nsms_live_...", "From the Nest SMS dashboard.")},
		Settings: append(append(append([]Setting{baseURLSetting("", "Required: Nest SMS publishes only a placeholder host; ask Nest SMS for the API host (e.g. https://api.example.com).", true)},
			senderSettings("Sender ID (optional).")...), messageTypeSetting(), maxConcurrencySetting()),
			pollSettings(20)...),
		DLRMode: DLRPoll, SupportsBalance: true, DestinationCountries: []string{"NP"},
		Notes: "Best effort: the docs show only a placeholder host, so the API base URL must be obtained from Nest SMS. " +
			"Same platform as MessengerNepal. Rate limit 60 requests/minute per key (polls count).",
	}
}

func msnpSend(ctx context.Context, c *Conn, m *Message, base string, nest bool) SendResult {
	if r := requireCreds(c, "token"); r != nil {
		return *r
	}
	if base == "" {
		return SendResult{Outcome: Rejected, ErrorCode: "BAD_CONFIG", Error: "API base URL is not set"}
	}
	to, r := requireNP(m)
	if r != nil {
		return *r
	}
	body := map[string]any{"to": to, "message": m.Text}
	if mt := c.Settings.Str("message_type", ""); mt != "" {
		body["message_type"] = mt
	}
	path := "/sms/send"
	if nest {
		path = "/api/v1/sms/send"
	}
	if s := c.sender(m, false); s != "" {
		body["sender_id"] = s
		if !nest {
			path = "/sms/send/with-sender-id"
		}
	}
	req, err := jsonRequest(http.MethodPost, base+path, body, hdr("X-API-Key", c.Cred("token"), "Idempotency-Key", m.ID))
	if err != nil {
		return SendResult{Outcome: Rejected, ErrorCode: "ENCODING_ERROR", Error: err.Error()}
	}
	resp, res, handled := c.exchange(ctx, req)
	if handled {
		return res
	}
	v, ok := parseJSON(resp.Body)
	succ, hasSucc := jbool(jpath(v, "success"))
	switch {
	case !ok || !hasSucc:
		if resp.Status/100 == 2 {
			return c.unparseable(res, resp)
		}
		return c.rejectHTTP(res, resp, "")
	case succ && resp.Status/100 == 2:
		res.Outcome = Accepted
		if id := jfirst(v, "data.message_id", "data.dispatch_id", "data.job_id", "data.dispatch_ids[0]"); id != "" {
			res.ProviderIDs = []string{id}
		}
		return res
	}
	code := jstr(jpath(v, "code"))
	if code == "" {
		code = fmt.Sprintf("HTTP_%d", resp.Status)
	}
	res.Outcome, res.ErrorCode = Rejected, code
	res.RecipientError = msnpRecipientCodes[code]
	res.Error = c.Mask(fmt.Sprintf("%s: %s", code, jfirst(v, "error", "message")))
	return res
}

func (messengerNepal) Send(ctx context.Context, c *Conn, m *Message) SendResult {
	return msnpSend(ctx, c, m, c.baseURL(msnpBase), false)
}

func (nestSMS) Send(ctx context.Context, c *Conn, m *Message) SendResult {
	return msnpSend(ctx, c, m, c.baseURL(""), true)
}

// ParseCallback verifies the signature (when webhook_secret is set) and
// reads {type, data:{message_id, status, error_code}} (or an array of them).
func (messengerNepal) ParseCallback(c *Conn, cb *Callback) ([]Receipt, error) {
	if sec := c.Cred("webhook_secret"); sec != "" {
		sig := strings.TrimSpace(cb.Headers["x-msngr-signature"])
		ts := strings.TrimSpace(cb.Headers["x-msngr-timestamp"])
		mac := hmac.New(sha256.New, []byte(sec))
		mac.Write([]byte(ts + "." + string(cb.Body)))
		want := "sha256=" + hex.EncodeToString(mac.Sum(nil))
		if sig == "" || !hmac.Equal([]byte(strings.ToLower(sig)), []byte(want)) {
			return nil, ErrBadSignature
		}
	}
	v, ok := parseJSON(cb.Body)
	if !ok {
		return nil, fmt.Errorf("messengernepal callback: body is not JSON")
	}
	items, isArr := v.([]any)
	if !isArr {
		items = []any{v}
	}
	var out []Receipt
	for _, it := range items {
		id := jfirst(it, "data.message_id", "data.dispatch_id", "message_id")
		st := jfirst(it, "data.status", "status")
		if st == "" {
			st = strings.TrimPrefix(jstr(jpath(it, "type")), "sms.")
		}
		if id == "" {
			continue
		}
		out = append(out, Receipt{ProviderID: id, Stat: msnpStat(st), Err: numericErr(jstr(jpath(it, "data.error_code"))), Raw: st})
	}
	return out, nil
}

// msnpStat maps the platform's statuses (accepted, sending, sent,
// delivered, failed, unknown, cancelled).
func msnpStat(s string) string {
	switch strings.ToLower(s) {
	case "delivered":
		return "DELIVRD"
	case "failed":
		return "UNDELIV"
	case "cancelled", "canceled", "rejected":
		return "REJECTD"
	case "expired":
		return "EXPIRED"
	case "unknown":
		return "UNKNOWN"
	}
	return ""
}

// numericErr keeps a provider error code as dlr_err only when it is numeric.
func numericErr(s string) string {
	s = strings.TrimSpace(s)
	if s == "" || digits(s) != s {
		return ""
	}
	return s
}

func (nestSMS) PollDLR(ctx context.Context, c *Conn, pending []Pending) ([]Receipt, error) {
	base := c.baseURL("")
	if base == "" {
		return nil, &ErrNotConfigured{What: "base_url"}
	}
	return pollEach(ctx, c, pending, func(p Pending) *Request {
		return getRequest(base+"/api/v1/sms/status/"+url.PathEscape(p.ProviderID), nil, hdr("X-API-Key", c.Cred("token")))
	}, func(v any) (string, string) {
		st := jfirst(v, "data.status", "status")
		return st, numericErr(jfirst(v, "data.error_code", "error_code"))
	}, msnpStat)
}

func (nestSMS) Balance(ctx context.Context, c *Conn) BalanceResult {
	base := c.baseURL("")
	if base == "" {
		return BalanceResult{Error: "API base URL is not set"}
	}
	req := getRequest(base+"/api/v1/sms/balance", nil, hdr("X-API-Key", c.Cred("token")))
	return balanceCall(ctx, c, req, func(v any, resp *Response) (bool, string) {
		if s, ok := jbool(jpath(v, "success")); (ok && !s) || resp.Status/100 != 2 {
			return false, fmt.Sprintf("HTTP %d: %s", resp.Status, jfirst(v, "error", "message"))
		}
		return true, ""
	}, "data.balance", "balance", "data.remaining_balance", "data.credits")
}

// pollEach fetches one status per pending message (bounded by
// dlr_poll_batch) and maps the status words with stat.
func pollEach(ctx context.Context, c *Conn, pending []Pending, req func(Pending) *Request,
	read func(v any) (status, errCode string), stat func(string) string) ([]Receipt, error) {
	limit := c.Settings.Int("dlr_poll_batch", 50)
	var out []Receipt
	var firstErr error
	n := 0
	for _, p := range pending {
		if p.ProviderID == "" {
			continue
		}
		if n >= limit || ctx.Err() != nil {
			break
		}
		n++
		resp, _, err := c.do(ctx, req(p))
		if err != nil {
			if firstErr == nil {
				firstErr = fmt.Errorf("status %s: %s", p.ProviderID, c.Mask(err.Error()))
			}
			continue
		}
		if resp.Status == http.StatusTooManyRequests {
			return out, fmt.Errorf("status poll rate limited (HTTP 429)")
		}
		v, ok := parseJSON(resp.Body)
		if !ok || resp.Status/100 != 2 {
			continue // e.g. 404 MESSAGE_NOT_FOUND: try again next poll
		}
		st, ec := read(v)
		if s := stat(st); s != "" {
			out = append(out, Receipt{ProviderID: p.ProviderID, Stat: s, Err: ec, Raw: st})
		}
	}
	return out, firstErr
}

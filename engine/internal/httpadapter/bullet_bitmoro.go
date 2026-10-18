package httpadapter

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// bulletSMS implements Bullet SMS (LIKELY: only the curl sample on
// bulletsms.com/developers): POST {base}/sms/send, Authorization: Bearer,
// Idempotency-Key, JSON {"to":["98..."],"message","senderId"}. Response,
// errors and message id are undocumented: 2xx is accepted unless the body
// says otherwise (success:false / status:error); the id is taken from the
// usual fields when present. HMAC-signed DLR webhooks are claimed but their
// payload is not public: callbacks are parsed best effort.
type bulletSMS struct{}

// bitmoro implements Bitmoro (LIKELY, possibly stale: npm bitmoro v1.1.2;
// the endpoint returned 404 when probed on 2026-10-18): POST
// {base}/message/api/bulk, Bearer, JSON {number:[...], message, senderId?,
// callbackUrl?}; {status:"QUEUED"|"SCHEDULED", report:[{to,messageId,...}],
// messageId}. DLR: a POST to the per-request callbackUrl (payload
// undocumented; parsed best effort).
type bitmoro struct{}

func init() {
	register(bulletSMS{})
	register(bitmoro{})
}

const (
	bulletBase  = "https://bulletsms.com/api/v1"
	bitmoroBase = "https://api.bitmoro.com"
)

func (bulletSMS) Info() Info {
	return Info{
		ID: "bulletsms", Name: "Bullet SMS (Zwicky Technology)", Country: "NP", Website: "https://bulletsms.com",
		DocsURL: strp("https://bulletsms.com/developers"), Confidence: ConfidenceLikely,
		Credentials: []Credential{tokenCred("API token", "", "Tokens can be scoped by domain, IP and sender ID.")},
		Settings: append(append([]Setting{baseURLSetting(bulletBase, "Override if Bullet SMS gives you another endpoint.", false)},
			senderSettings("Sender ID registered with Bullet SMS.")...), maxConcurrencySetting()),
		DLRMode: DLRCallback, SupportsBalance: false, DestinationCountries: []string{"NP"},
		Notes: "Best effort: only a request sample is public (response, errors and delivery-webhook format are undocumented). " +
			"Configure the DLR callback URL shown here as the delivery webhook in Bullet SMS; its signature is not verified. " +
			"Send a test SMS before enabling the route.",
	}
}

func (bitmoro) Info() Info {
	return Info{
		ID: "bitmoro", Name: "Bitmoro", Country: "NP", Website: "https://bitmoro.com",
		DocsURL: strp("https://www.npmjs.com/package/bitmoro"), Confidence: ConfidenceLikely,
		Credentials: []Credential{tokenCred("API token", "", "From the Bitmoro dashboard.")},
		Settings: append(append([]Setting{baseURLSetting(bitmoroBase, "The documented endpoint returned 404 in Oct 2026: confirm the current host with Bitmoro.", false)},
			senderSettings("Sender ID registered in Bitmoro (optional).")...), maxConcurrencySetting()),
		DLRMode: DLRCallback, SupportsBalance: false, DestinationCountries: []string{"NP"},
		Notes: "Best effort and possibly stale (source: the bitmoro npm SDK; the bulk endpoint returned 404 when probed). " +
			"The DLR callback URL is sent with every message (callbackUrl) when the engine knows the public API URL (PUBLIC_API_BASE_URL). " +
			"Bitmoro's 'sent' status is treated as delivered (its SDK has no 'delivered' status).",
	}
}

// genericAccept reads an undocumented 2xx response: accepted unless it
// says success:false / status:error|failed.
func (c *Conn) genericAccept(res SendResult, resp *Response, idPaths ...string) SendResult {
	v, ok := parseJSON(resp.Body)
	if ok {
		if s, has := jbool(jpath(v, "success")); has && !s {
			res.Outcome, res.ErrorCode = Rejected, "PROVIDER_ERROR"
			res.Error = c.Mask("provider error: " + jfirst(v, "message", "error", "error.message"))
			return res
		}
		if st := strings.ToLower(jstr(jpath(v, "status"))); st == "error" || st == "failed" || st == "fail" {
			res.Outcome, res.ErrorCode = Rejected, "PROVIDER_ERROR"
			res.Error = c.Mask("provider error: " + jfirst(v, "message", "error"))
			return res
		}
		if id := jfirst(v, idPaths...); id != "" {
			res.ProviderIDs = []string{id}
		}
	}
	res.Outcome = Accepted
	return res
}

func (bulletSMS) Send(ctx context.Context, c *Conn, m *Message) SendResult {
	if r := requireCreds(c, "token"); r != nil {
		return *r
	}
	to, r := requireNP(m)
	if r != nil {
		return *r
	}
	body := map[string]any{"to": []string{to}, "message": m.Text}
	if s := c.sender(m, false); s != "" {
		body["senderId"] = s
	}
	req, err := jsonRequest(http.MethodPost, c.baseURL(bulletBase)+"/sms/send", body,
		hdr("Authorization", "Bearer "+c.Cred("token"), "Idempotency-Key", m.ID))
	if err != nil {
		return SendResult{Outcome: Rejected, ErrorCode: "ENCODING_ERROR", Error: err.Error()}
	}
	resp, res, handled := c.exchange(ctx, req)
	if handled {
		return res
	}
	if resp.Status/100 != 2 {
		v, _ := parseJSON(resp.Body)
		return c.rejectHTTP(res, resp, jfirst(v, "message", "error", "error.message"))
	}
	return c.genericAccept(res, resp, "data.messageId", "data.message_id", "data.id", "data.messages[0].id",
		"data.messages[0].messageId", "data[0].messageId", "data[0].id", "messageId", "message_id", "id")
}

func (bitmoro) Send(ctx context.Context, c *Conn, m *Message) SendResult {
	if r := requireCreds(c, "token"); r != nil {
		return *r
	}
	to, r := requireNP(m)
	if r != nil {
		return *r
	}
	body := map[string]any{"number": []string{to}, "message": m.Text}
	if s := c.sender(m, false); s != "" {
		body["senderId"] = s
	}
	if m.CallbackURL != "" {
		body["callbackUrl"] = m.CallbackURL
	}
	req, err := jsonRequest(http.MethodPost, c.baseURL(bitmoroBase)+"/message/api/bulk", body, hdr("Authorization", "Bearer "+c.Cred("token")))
	if err != nil {
		return SendResult{Outcome: Rejected, ErrorCode: "ENCODING_ERROR", Error: err.Error()}
	}
	resp, res, handled := c.exchange(ctx, req)
	if handled {
		return res
	}
	v, ok := parseJSON(resp.Body)
	if resp.Status/100 != 2 {
		return c.rejectHTTP(res, resp, jfirst(v, "message", "error"))
	}
	if !ok {
		return c.unparseable(res, resp)
	}
	switch st := strings.ToUpper(jstr(jpath(v, "status"))); st {
	case "QUEUED", "SCHEDULED", "DISPATCHED":
		res.Outcome = Accepted
		if id := jfirst(v, "report[0].messageId", "messageId"); id != "" {
			res.ProviderIDs = []string{id}
		}
		return res
	case "FAILED":
		res.Outcome, res.ErrorCode = Rejected, "PROVIDER_FAILED"
		res.Error = c.Mask("Bitmoro: " + jfirst(v, "message", "error", "status"))
		return res
	}
	return c.genericAccept(res, resp, "report[0].messageId", "messageId")
}

// parseLooseCallback reads an undocumented DLR callback: JSON body (object
// or array), form body or query, with the id and status under the usual
// names. stat maps status words.
func parseLooseCallback(cb *Callback, stat func(string) string) ([]Receipt, error) {
	var items []any
	if v, ok := parseJSON(cb.Body); ok {
		if arr, isArr := v.([]any); isArr {
			items = arr
		} else if arr, isArr := jpath(v, "data").([]any); isArr {
			items = arr
		} else {
			items = []any{v}
		}
	} else {
		obj := map[string]any{}
		if f, err := url.ParseQuery(string(cb.Body)); err == nil {
			for k := range f {
				obj[k] = f.Get(k)
			}
		}
		for k := range cb.Query {
			if _, set := obj[k]; !set {
				obj[k] = cb.QueryValue(k)
			}
		}
		items = []any{obj}
	}
	var out []Receipt
	for _, it := range items {
		id := jfirst(it, "messageId", "message_id", "msgId", "msg_id", "id", "data.messageId", "data.message_id", "data.id")
		st := jfirst(it, "status", "deliveryStatus", "delivery_status", "state", "data.status")
		if id == "" || st == "" {
			continue
		}
		out = append(out, Receipt{ProviderID: id, Stat: stat(st), Err: numericErr(jfirst(it, "errorCode", "error_code", "err")), Raw: st})
	}
	if len(items) > 0 && len(out) == 0 {
		return nil, fmt.Errorf("callback carried no message id / status")
	}
	return out, nil
}

func (bulletSMS) ParseCallback(_ *Conn, cb *Callback) ([]Receipt, error) {
	return parseLooseCallback(cb, statWord)
}

func (bitmoro) ParseCallback(_ *Conn, cb *Callback) ([]Receipt, error) {
	return parseLooseCallback(cb, func(s string) string {
		if strings.EqualFold(strings.TrimSpace(s), "sent") {
			return "DELIVRD"
		}
		return statWord(s)
	})
}

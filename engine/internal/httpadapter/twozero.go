package httpadapter

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// twozero implements Twozero SMS (VERIFIED, sms.twozero.io/api-docs):
// POST {base}/sms/send, header X-API-Key, Idempotency-Key, JSON {to,
// message, sender_id?}; success HTTP 200 {"status":"success","data":
// {"message_id":"msg_..."}}; errors {"status":"error","message":...} with
// HTTP 400/401/403/404/409/422 (definite) or 429/500 (retry). DLR: poll GET
// {base}/sms/status/{id} → data.status pending|sent|delivered|failed|
// rejected. Balance GET {base}/account/balance → data.credits.
type twozero struct{}

func init() { register(twozero{}) }

const twozeroBase = "https://sms.twozero.io/api/v1"

func (twozero) Info() Info {
	return Info{
		ID: "twozero", Name: "Twozero SMS", Country: "NP", Website: "https://sms.twozero.io",
		DocsURL: strp("https://sms.twozero.io/api-docs"), Confidence: ConfidenceVerified,
		Credentials: []Credential{tokenCred("API key", "sk_...", "From the Twozero dashboard.")},
		Settings: append(append(append([]Setting{baseURLSetting(twozeroBase, "Override only if Twozero gives you another endpoint.", false)},
			senderSettings("Sender ID (max 11 characters). Blank = the account's default sender.")...), maxConcurrencySetting()),
			pollSettings(50)...),
		DLRMode: DLRPoll, SupportsBalance: true, DestinationCountries: []string{"NP"},
		Notes: "Reseller that fails over between Nepali gateways. KYC is required before sending to numbers other than your own. " +
			"Accounts can be IP-restricted (HTTP 403). Rate limits: send 100/min, status 300/min per key.",
	}
}

func (twozero) Send(ctx context.Context, c *Conn, m *Message) SendResult {
	if r := requireCreds(c, "token"); r != nil {
		return *r
	}
	to, r := requireNP(m)
	if r != nil {
		return *r
	}
	body := map[string]any{"to": to, "message": m.Text}
	if s := c.sender(m, false); s != "" {
		body["sender_id"] = s
	}
	req, err := jsonRequest(http.MethodPost, c.baseURL(twozeroBase)+"/sms/send", body, hdr("X-API-Key", c.Cred("token"), "Idempotency-Key", m.ID))
	if err != nil {
		return SendResult{Outcome: Rejected, ErrorCode: "ENCODING_ERROR", Error: err.Error()}
	}
	resp, res, handled := c.exchange(ctx, req)
	if handled {
		return res
	}
	v, ok := parseJSON(resp.Body)
	status := strings.ToLower(jstr(jpath(v, "status")))
	switch {
	case !ok || status == "":
		if resp.Status/100 == 2 {
			return c.unparseable(res, resp)
		}
		return c.rejectHTTP(res, resp, "")
	case status == "success" && resp.Status/100 == 2:
		res.Outcome = Accepted
		if id := jstr(jpath(v, "data.message_id")); id != "" {
			res.ProviderIDs = []string{id}
		}
		if st := strings.ToLower(jstr(jpath(v, "data.status"))); st == "failed" || st == "rejected" {
			res.Outcome, res.ErrorCode = Rejected, "PROVIDER_"+strings.ToUpper(st)
			res.Error = "Twozero reported the message " + st
		}
		return res
	}
	msg := jstr(jpath(v, "message"))
	res.Outcome = Rejected
	res.ErrorCode = fmt.Sprintf("HTTP_%d", resp.Status)
	if strings.Contains(strings.ToLower(msg), "credit") {
		res.ErrorCode = "INSUFFICIENT_CREDITS"
	}
	res.RecipientError = resp.Status == http.StatusUnprocessableEntity
	res.Error = c.Mask(fmt.Sprintf("Twozero HTTP %d: %s", resp.Status, msg))
	return res
}

func twozeroStat(s string) string {
	switch strings.ToLower(s) {
	case "delivered":
		return "DELIVRD"
	case "failed":
		return "UNDELIV"
	case "rejected":
		return "REJECTD"
	case "expired":
		return "EXPIRED"
	}
	return "" // pending, sent
}

func (twozero) PollDLR(ctx context.Context, c *Conn, pending []Pending) ([]Receipt, error) {
	base := c.baseURL(twozeroBase)
	return pollEach(ctx, c, pending, func(p Pending) *Request {
		return getRequest(base+"/sms/status/"+url.PathEscape(p.ProviderID), nil, hdr("X-API-Key", c.Cred("token")))
	}, func(v any) (string, string) {
		return jfirst(v, "data.status", "data.delivery_report.status"), ""
	}, twozeroStat)
}

func (twozero) Balance(ctx context.Context, c *Conn) BalanceResult {
	req := getRequest(c.baseURL(twozeroBase)+"/account/balance", nil, hdr("X-API-Key", c.Cred("token")))
	return balanceCall(ctx, c, req, func(v any, resp *Response) (bool, string) {
		if strings.ToLower(jstr(jpath(v, "status"))) != "success" || resp.Status/100 != 2 {
			return false, fmt.Sprintf("HTTP %d: %s", resp.Status, jstr(jpath(v, "message")))
		}
		return true, ""
	}, "data.credits")
}

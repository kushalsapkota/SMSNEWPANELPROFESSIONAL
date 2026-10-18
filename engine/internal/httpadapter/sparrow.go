package httpadapter

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
)

// sparrow implements Sparrow SMS API v2 (VERIFIED, docs.sparrowsms.com):
// POST {base}/sms/ form token, from, to (10-digit local), text.
// Success HTTP 200 {"count":N,"response_code":200,"response":"..."} with no
// message id; errors HTTP 403 {"response_code":<1000-1013>,"response":"..."}.
// No DLR (dashboard only). Balance GET {base}/credit/?token= →
// credits_available.
type sparrow struct{}

func init() { register(sparrow{}) }

const sparrowBase = "https://api.sparrowsms.com/v2"

func (sparrow) Info() Info {
	return Info{
		ID: "sparrow_v2", Name: "Sparrow SMS (API v2)", Country: "NP", Website: "https://sparrowsms.com",
		DocsURL: strp("https://docs.sparrowsms.com/sms/outgoing_sendsms/"), Confidence: ConfidenceVerified,
		Credentials: []Credential{tokenCred("API token", "v2_...", "Generated in the Sparrow dashboard.")},
		Settings: append(append([]Setting{baseURLSetting(sparrowBase, "Override only if Sparrow gives you another endpoint.", false)},
			senderSettings("Identity assigned to your Sparrow account (the `from` field, required by Sparrow). Blank = the message's sender.")...),
			maxConcurrencySetting()),
		DLRMode: DLRNone, SupportsBalance: true, DestinationCountries: []string{"NP"},
		Notes: "Sparrow's v2 API returns no message id and has no delivery reports: messages stay 'Sent (provider gives no delivery report)'. " +
			"Sparrow accounts are IP-whitelisted (error 1001): register the gateway's egress IPs. Errors come back as HTTP 403 with a numeric code.",
	}
}

// sparrowRecipientCodes are rejections about the message, not the account.
var sparrowRecipientCodes = map[string]bool{"1007": true, "1010": true, "1011": true}

func (sparrow) Send(ctx context.Context, c *Conn, m *Message) SendResult {
	if r := requireCreds(c, "token"); r != nil {
		return *r
	}
	to, r := requireNP(m)
	if r != nil {
		return *r
	}
	form := url.Values{"token": {c.Cred("token")}, "from": {c.sender(m, true)}, "to": {to}, "text": {m.Text}}
	resp, res, handled := c.exchange(ctx, formRequest(c.baseURL(sparrowBase)+"/sms/", form))
	if handled {
		return res
	}
	v, ok := parseJSON(resp.Body)
	code := jstr(jpath(v, "response_code"))
	msg := jstr(jpath(v, "response"))
	switch {
	case !ok || code == "":
		if resp.Status/100 == 2 {
			return c.unparseable(res, resp)
		}
		return c.rejectHTTP(res, resp, "")
	case resp.Status == http.StatusOK && code == "200":
		if n := jstr(jpath(v, "count")); n == "0" {
			res.Outcome, res.ErrorCode, res.RecipientError = Rejected, "1011", true
			res.Error = c.Mask("no message queued: " + msg)
			return res
		}
		res.Outcome = Accepted
		return res
	}
	res.Outcome = Rejected
	res.ErrorCode = code
	res.RecipientError = sparrowRecipientCodes[code]
	res.Error = c.Mask(fmt.Sprintf("Sparrow error %s: %s", code, msg))
	return res
}

func (sparrow) Balance(ctx context.Context, c *Conn) BalanceResult {
	req := getRequest(c.baseURL(sparrowBase)+"/credit/", url.Values{"token": {c.Cred("token")}}, nil)
	return balanceCall(ctx, c, req, func(v any, resp *Response) (bool, string) {
		if jstr(jpath(v, "response_code")) == "200" {
			return true, ""
		}
		return false, fmt.Sprintf("Sparrow error %s: %s", jstr(jpath(v, "response_code")), jstr(jpath(v, "response")))
	}, "credits_available")
}

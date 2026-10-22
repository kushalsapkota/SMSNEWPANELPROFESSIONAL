package httpadapter

import (
	"context"
	"net/url"
	"strings"
)

// kavrelisms implements the Kavreli SMS endpoint (the sms.aspx relay page).
// It takes no API key: a message is a form-urlencoded POST {base_url} with
//
//	mobile=<local 10-digit>&message=<text>
//
// (the page reads Request["mobile"] and Request["message"], so form data is
// the reliable form; it also normalises the number itself). The number is
// sent as the Nepali local 10-digit form (98XXXXXXXX). The page answers
// HTTP 200 {"status":"success",...} on success and 400/500
// {"status":"error","message":...} on failure, with no message id, so there
// are no delivery reports (messages end as "Sent (provider gives no
// delivery report)"). Any 2xx is accepted; a 2xx body reporting status
// "error"/"failed" (or success:false) is a rejection; other 4xx are
// rejections and 408/429/5xx retry.
type kavrelisms struct{}

func init() { register(kavrelisms{}) }

func (kavrelisms) Info() Info {
	return Info{
		ID: "kavrelisms", Name: "Kavreli SMS", Country: "NP", Website: "",
		DocsURL: nil, Confidence: ConfidenceLikely,
		Credentials: []Credential{}, // no authentication; must be [] not null (the api/web map over it)
		Settings: []Setting{
			baseURLSetting("", "The Kavreli SMS page URL the message is POSTed to (the sms.aspx page), e.g. https://yourdomain.com/path/to/page.aspx.", true),
			maxConcurrencySetting(),
		},
		DLRMode: DLRNone, SupportsBalance: false, DestinationCountries: []string{"NP"},
		Notes: "No API key: a message is a form POST with mobile=<local 10-digit>&message=<text>. The recipient is sent as the " +
			"Nepali local 10-digit number (98XXXXXXXX). No message id and no delivery reports: messages show " +
			"'Sent (provider gives no delivery report)'. Any 2xx response is treated as accepted.",
	}
}

// AcceptIsDelivery: Kavreli SMS has no delivery reports and a 2xx accept is
// the only (and final) delivery signal, so accepted messages are recorded
// DELIVERED rather than "Sent (provider gives no delivery report)".
func (kavrelisms) AcceptIsDelivery(*Conn) bool { return true }

func (kavrelisms) Send(ctx context.Context, c *Conn, m *Message) SendResult {
	endpoint := c.baseURL("")
	if endpoint == "" {
		return SendResult{Outcome: Rejected, ErrorCode: "BAD_CONFIG", Error: "API base URL is not set"}
	}
	to, r := requireNP(m)
	if r != nil {
		return *r
	}
	form := url.Values{"mobile": {to}, "message": {m.Text}}
	resp, res, handled := c.exchange(ctx, formRequest(endpoint, form))
	if handled {
		return res
	}
	v, ok := parseJSON(resp.Body)
	if resp.Status/100 == 2 {
		if ok {
			if st := strings.ToLower(jstr(jpath(v, "status"))); st == "error" || st == "failed" || st == "fail" {
				res.Outcome, res.ErrorCode = Rejected, "PROVIDER_ERROR"
				res.Error = c.Mask("provider error: " + jfirst(v, "message", "error", "msg"))
				return res
			}
			if b, has := jbool(jpath(v, "success")); has && !b {
				res.Outcome, res.ErrorCode = Rejected, "PROVIDER_ERROR"
				res.Error = c.Mask("provider error: " + jfirst(v, "message", "error", "msg"))
				return res
			}
		}
		// Accepted, no provider id: no delivery report is possible.
		res.Outcome = Accepted
		return res
	}
	msg := ""
	if ok {
		msg = jfirst(v, "message", "error", "msg")
	}
	return c.rejectHTTP(res, resp, msg)
}

package httpadapter

import (
	"context"
	"fmt"
	"net/http"
	"time"
)

// swift implements Swift Technology SmartSMS (LIKELY: from the third-party
// rayzenai/laravel-sms v7.0.0 SwiftSmsProvider; Swift shares its spec with
// customers only). POST {base}/ExecuteSendSmsV5, HTTP Basic
// (username:password) plus header OrganisationCode, JSON {Message,
// ReceiverNo, IsClientLogin:"N", Date:"yyyy/MM/dd HH:mm:ss"}; success
// responseCode == 100 with messageId; other codes are unknown (treated as
// rejections with responseDescription). No DLR / balance API known.
type swift struct{}

func init() { register(swift{}) }

const swiftBase = "https://smartsms.swifttech.com.np:8083/api/Sms"

// nepalTime is NPT (UTC+05:45) for the Date field.
var nepalTime = time.FixedZone("NPT", 5*3600+45*60)

func (swift) Info() Info {
	return Info{
		ID: "swift_smartsms", Name: "Swift Technology SmartSMS", Country: "NP", Website: "https://swifttech.com.np/enterprise-messaging/",
		DocsURL: nil, Confidence: ConfidenceLikely,
		Credentials: []Credential{
			{Key: "username", Label: "Username", Secret: false, Required: true},
			{Key: "password", Label: "Password", Secret: true, Required: true},
			{Key: "organisation_code", Label: "Organisation code", Secret: false, Required: true, Help: "Sent as the OrganisationCode header."},
		},
		Settings: []Setting{
			baseURLSetting(swiftBase, "Swift's API base (ask Swift to confirm; port 8083 may be reachable only from whitelisted IPs).", false),
			{Key: "recipient_format", Label: "Recipient number format", Type: TypeSelect, Default: "plus977",
				Options: []string{"plus977", "local10", "msisdn"},
				Help:    "plus977 = +9779841234567 (what the only known client library sends), local10 = 9841234567, msisdn = 9779841234567. Confirm with Swift."},
			maxConcurrencySetting(),
		},
		DLRMode: DLRNone, SupportsBalance: false, DestinationCountries: []string{"NP"},
		Notes: "Best effort: Swift publishes no API docs; this follows a third-party client library. Only responseCode 100 (success) is known. " +
			"No sender parameter (fixed per organisation) and no delivery-report or balance API is known.",
	}
}

func (swift) Send(ctx context.Context, c *Conn, m *Message) SendResult {
	if r := requireCreds(c, "username", "password", "organisation_code"); r != nil {
		return *r
	}
	if _, r := requireNP(m); r != nil {
		return *r
	}
	body := map[string]any{
		"Message":       m.Text,
		"ReceiverNo":    FormatRecipient(m.To, c.Settings.Str("recipient_format", "plus977")),
		"IsClientLogin": "N",
		"Date":          time.Now().In(nepalTime).Format("2006/01/02 15:04:05"),
	}
	req, err := jsonRequest(http.MethodPost, c.baseURL(swiftBase)+"/ExecuteSendSmsV5", body, hdr("OrganisationCode", c.Cred("organisation_code")))
	if err != nil {
		return SendResult{Outcome: Rejected, ErrorCode: "ENCODING_ERROR", Error: err.Error()}
	}
	setBasicAuth(req, c.Cred("username"), c.Cred("password"))
	resp, res, handled := c.exchange(ctx, req)
	if handled {
		return res
	}
	v, ok := parseJSON(resp.Body)
	code := jfirst(v, "responseCode", "ResponseCode")
	switch {
	case !ok || code == "":
		if resp.Status/100 == 2 {
			return c.unparseable(res, resp)
		}
		return c.rejectHTTP(res, resp, "")
	case code == "100" && resp.Status/100 == 2:
		res.Outcome = Accepted
		if id := jfirst(v, "messageId", "MessageId"); id != "" && id != "0" {
			res.ProviderIDs = []string{id}
		}
		return res
	}
	res.Outcome, res.ErrorCode = Rejected, "SWIFT_"+code
	res.Error = c.Mask(fmt.Sprintf("Swift responseCode %s: %s", code, jfirst(v, "responseDescription", "ResponseDescription")))
	return res
}

func setBasicAuth(r *Request, user, pass string) {
	hr, _ := http.NewRequest(http.MethodGet, "http://x/", nil)
	hr.SetBasicAuth(user, pass)
	r.Header.Set("Authorization", hr.Header.Get("Authorization"))
}

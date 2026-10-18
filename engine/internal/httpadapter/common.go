package httpadapter

import (
	"context"
	"fmt"
	"net/http"
	"strings"
)

// Shared catalogue fields.

func strp(s string) *string { return &s }

func tokenCred(label, placeholder, help string) Credential {
	return Credential{Key: "token", Label: label, Secret: true, Required: true, Placeholder: placeholder, Help: help}
}

func baseURLSetting(def, help string, required bool) Setting {
	var d any = def
	if def == "" {
		d = nil
	}
	return Setting{Key: "base_url", Label: "API base URL", Type: TypeURL, Default: d, Required: required, Help: help}
}

func maxConcurrencySetting() Setting {
	return Setting{Key: "max_concurrency", Label: "Max concurrent requests", Type: TypeNumber, Default: 10,
		Help: "Requests in flight at once on this connection (default 10). max_tps still applies."}
}

func senderSettings(help string) []Setting {
	return []Setting{
		{Key: "sender", Label: "Sender ID", Type: TypeString, Help: help},
		{Key: "use_message_sender", Label: "Use the message's sender when Sender ID is blank", Type: TypeBool, Default: false,
			Help: "Off: blank Sender ID uses the account's default sender. On: the client's (or route's forced) sender is passed."},
	}
}

func pollSettings(defBatch int) []Setting {
	return []Setting{
		{Key: "dlr_poll_interval_s", Label: "Delivery report poll interval (seconds)", Type: TypeNumber, Default: 60,
			Help: "How often submitted messages of the last 48 hours are checked (min 10)."},
		{Key: "dlr_poll_batch", Label: "Messages checked per poll", Type: TypeNumber, Default: defBatch,
			Help: "Upper bound of messages (or report pages) fetched per poll, to stay within provider rate limits."},
	}
}

// requireCreds returns a rejected result when a required credential is
// missing (connection misconfigured).
func requireCreds(c *Conn, keys ...string) *SendResult {
	for _, k := range keys {
		if c.Cred(k) == "" {
			return &SendResult{Outcome: Rejected, ErrorCode: "BAD_CONFIG", Error: fmt.Sprintf("credential %q is not set", k)}
		}
	}
	return nil
}

// requireNP returns the local 10-digit number or a rejected result.
func requireNP(m *Message) (string, *SendResult) {
	l := NepalLocal(m.To)
	if l == "" {
		return "", &SendResult{Outcome: Rejected, ErrorCode: "DESTINATION_NOT_SUPPORTED", RecipientError: true,
			Error: "destination is not a Nepali mobile number"}
	}
	return l, nil
}

// statWord maps common provider status words to receipt stats ("" = not
// final).
func statWord(s string) string {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "delivered", "delivrd", "success", "successful", "delivery_success":
		return "DELIVRD"
	case "failed", "undelivered", "undeliv", "delivery_failed", "failure", "error":
		return "UNDELIV"
	case "rejected", "rejectd", "cancelled", "canceled", "cancel", "spam", "blocked", "invalid":
		return "REJECTD"
	case "expired":
		return "EXPIRED"
	case "unknown":
		return "UNKNOWN"
	}
	return ""
}

// balanceCall runs a balance request and extracts the value at paths.
func balanceCall(ctx context.Context, c *Conn, req *Request, okFn func(v any, resp *Response) (bool, string), paths ...string) BalanceResult {
	resp, ex, err := c.do(ctx, req)
	out := BalanceResult{Exchange: ex}
	if err != nil {
		out.Error = c.Mask(err.Error())
		return out
	}
	out.Raw = string(resp.Body)
	v, isJSON := parseJSON(resp.Body)
	if !isJSON {
		out.Error = fmt.Sprintf("HTTP %d: unrecognised response", resp.Status)
		return out
	}
	if okFn != nil {
		if ok, msg := okFn(v, resp); !ok {
			if msg == "" {
				msg = fmt.Sprintf("HTTP %d", resp.Status)
			}
			out.Error = c.Mask(msg)
			return out
		}
	} else if resp.Status/100 != 2 {
		out.Error = c.Mask(fmt.Sprintf("HTTP %d: %s", resp.Status, snippet(resp.Body, 200)))
		return out
	}
	out.Balance = jfirst(v, paths...)
	if out.Balance == "" {
		out.Error = "balance not found in the response"
	}
	return out
}

func hdr(kv ...string) http.Header {
	h := http.Header{}
	for i := 0; i+1 < len(kv); i += 2 {
		h.Set(kv[i], kv[i+1])
	}
	return h
}

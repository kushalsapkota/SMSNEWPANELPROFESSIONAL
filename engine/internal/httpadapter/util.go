package httpadapter

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"smsgw/engine/internal/phone"
)

// --- settings ----------------------------------------------------------------

// Settings are a connection's http_settings (JSON object). Accessors are
// lenient: numbers may arrive as JSON numbers or strings.
type Settings map[string]any

// Str returns a string setting (trimmed); def when unset or empty.
func (s Settings) Str(k, def string) string {
	switch v := s[k].(type) {
	case string:
		if t := strings.TrimSpace(v); t != "" {
			return t
		}
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	case json.Number:
		return v.String()
	case bool:
		return strconv.FormatBool(v)
	}
	return def
}

// Int returns an integer setting; def when unset or not a number.
func (s Settings) Int(k string, def int) int {
	switch v := s[k].(type) {
	case int:
		return v
	case int64:
		return int(v)
	case float64:
		if v == math.Trunc(v) && math.Abs(v) < 1e9 {
			return int(v)
		}
	case json.Number:
		if n, err := v.Int64(); err == nil {
			return int(n)
		}
	case string:
		if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
			return n
		}
	}
	return def
}

// Bool returns a boolean setting; def when unset.
func (s Settings) Bool(k string, def bool) bool {
	switch v := s[k].(type) {
	case bool:
		return v
	case string:
		switch strings.ToLower(strings.TrimSpace(v)) {
		case "1", "true", "yes", "on":
			return true
		case "0", "false", "no", "off":
			return false
		}
	case float64:
		return v != 0
	}
	return def
}

// baseURL returns the base_url setting (or def) without a trailing slash.
func (c *Conn) baseURL(def string) string {
	return strings.TrimRight(c.Settings.Str("base_url", def), "/")
}

// sender resolves the sender identity: the "sender" setting, else the
// message's own sender when "use_message_sender" is on (or required).
func (c *Conn) sender(m *Message, required bool) string {
	if s := c.Settings.Str("sender", ""); s != "" {
		return s
	}
	if required || c.Settings.Bool("use_message_sender", false) {
		return m.Source
	}
	return ""
}

// --- destinations ------------------------------------------------------------

var npLocal = regexp.MustCompile(`^9\d{9}$`)

// NepalLocal returns the local 10-digit form (98XXXXXXXX) of a Nepali mobile
// number given as E.164 digits (977 + 10 digits) or already local; "" when
// the number is not a Nepali mobile number.
func NepalLocal(to string) string {
	d := digits(to)
	if strings.HasPrefix(d, "00977") {
		d = d[2:]
	}
	if len(d) == 13 && strings.HasPrefix(d, "977") {
		d = d[3:]
	}
	if npLocal.MatchString(d) {
		return d
	}
	return ""
}

// FormatRecipient renders E.164 digits per format: "local10" (Nepal local
// 10 digits), "national" (country code stripped), "msisdn" (digits),
// "e164" (+digits), "plus977" (+977 and the Nepal local number).
func FormatRecipient(to, format string) string {
	d := digits(to)
	switch format {
	case "local10":
		if l := NepalLocal(d); l != "" {
			return l
		}
		return d
	case "national":
		if _, p, ok := phone.Country(d); ok && len(d) > len(p) {
			return d[len(p):]
		}
		return d
	case "e164":
		return "+" + d
	case "plus977":
		if l := NepalLocal(d); l != "" {
			return "+977" + l
		}
		return "+" + d
	}
	return d
}

func digits(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// --- JSON --------------------------------------------------------------------

func marshalJSON(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// parseJSON decodes b (numbers as json.Number); ok=false when b is not JSON.
func parseJSON(b []byte) (any, bool) {
	b = bytes.TrimSpace(bytes.TrimPrefix(b, []byte("\xef\xbb\xbf")))
	if len(b) == 0 {
		return nil, false
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, false
	}
	return v, true
}

var pathPart = regexp.MustCompile(`^([^\[\]]*)((?:\[\d+\])*)$`)
var pathIdx = regexp.MustCompile(`\[(\d+)\]`)

// jpath walks v along a dotted path with optional indexes:
// "data.valid[0].id", "responses[0].error". nil when missing.
func jpath(v any, path string) any {
	if path == "" {
		return v
	}
	for _, seg := range strings.Split(path, ".") {
		m := pathPart.FindStringSubmatch(seg)
		if m == nil {
			return nil
		}
		if m[1] != "" {
			obj, ok := v.(map[string]any)
			if !ok {
				return nil
			}
			v = obj[m[1]]
		}
		for _, ix := range pathIdx.FindAllStringSubmatch(m[2], -1) {
			arr, ok := v.([]any)
			if !ok {
				return nil
			}
			i, _ := strconv.Atoi(ix[1])
			if i >= len(arr) {
				return nil
			}
			v = arr[i]
		}
	}
	return v
}

// jstr renders a JSON scalar as text ("" for nil / objects / arrays).
func jstr(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case json.Number:
		return x.String()
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(x)
	}
	return ""
}

// jfirst returns the first non-empty scalar among paths.
func jfirst(v any, paths ...string) string {
	for _, p := range paths {
		if s := jstr(jpath(v, p)); s != "" {
			return s
		}
	}
	return ""
}

// jbool reports whether v is JSON true/false (or "true"/"false").
func jbool(v any) (val, ok bool) {
	switch x := v.(type) {
	case bool:
		return x, true
	case string:
		switch strings.ToLower(x) {
		case "true":
			return true, true
		case "false":
			return false, true
		}
	}
	return false, false
}

// --- masking -----------------------------------------------------------------

// maskSecrets replaces every secret (and its URL / JSON / base64 encodings)
// in s with "***". Secrets shorter than 3 characters are not masked (they
// would garble unrelated text); the api requires real credentials anyway.
func maskSecrets(s string, secrets []string) string {
	if s == "" {
		return s
	}
	for _, sec := range secrets {
		if len(sec) < 3 {
			continue
		}
		forms := []string{sec, url.QueryEscape(sec), url.PathEscape(sec), base64.StdEncoding.EncodeToString([]byte(sec))}
		if b, err := json.Marshal(sec); err == nil && len(b) >= 2 {
			forms = append(forms, string(b[1:len(b)-1]))
		}
		for _, f := range forms {
			if f != "" {
				s = strings.ReplaceAll(s, f, "***")
			}
		}
	}
	return s
}

// ErrBadSignature reports a DLR callback whose signature does not verify.
var ErrBadSignature = errors.New("httpadapter: callback signature mismatch")

// ErrNotConfigured reports a connection missing a required setting.
type ErrNotConfigured struct{ What string }

func (e *ErrNotConfigured) Error() string { return fmt.Sprintf("not configured: %s", e.What) }

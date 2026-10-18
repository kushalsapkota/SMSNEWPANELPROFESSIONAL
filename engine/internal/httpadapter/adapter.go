// Package httpadapter implements upstream connections over provider HTTP
// APIs (upstream_connections.kind = 'HTTP'). Each provider is an Adapter
// registered under a stable id (docs/providers/HTTP-CONNECTIONS-CONTRACT.md);
// the catalogue (Info of every adapter) is served to the api by
// GET /internal/v1/adapters and is the single source of truth for the
// credentials and settings an adapter takes.
//
// Adapters are stateless: every call receives a *Conn (decrypted
// credentials, settings, transport) and returns a classified outcome:
//
//   - Accepted: the provider took the message (provider ids, if any);
//   - Rejected: definitely not accepted (documented error code / 4xx other
//     than 408 and 429): the dispatcher fails over, then FAILED + refund;
//   - Retry: transient (429 / 5xx / network error before the request was
//     written): retried with backoff on the same connection, then failover;
//   - Unknown: the request may have been processed (timeout or connection
//     loss after the request was written, unparseable 2xx): never resent.
//
// Secrets (credential values marked Secret) are masked in everything an
// adapter exposes (errors, the test-send echo, status) with Conn.Mask.
package httpadapter

import (
	"context"
	"net/http"
	"sort"
	"strings"
	"time"
)

// Confidence levels of an adapter's spec (docs/providers/nepal.md).
const (
	ConfidenceVerified = "VERIFIED"
	ConfidenceLikely   = "LIKELY"
)

// DLR modes.
const (
	DLRNone     = "none"
	DLRPoll     = "poll"
	DLRCallback = "callback"
)

// Setting types.
const (
	TypeURL    = "url"
	TypeString = "string"
	TypeNumber = "number"
	TypeBool   = "bool"
	TypeSelect = "select"
)

// Credential describes one credential an adapter takes (stored encrypted).
type Credential struct {
	Key         string `json:"key"`
	Label       string `json:"label"`
	Secret      bool   `json:"secret"`
	Required    bool   `json:"required"`
	Placeholder string `json:"placeholder"`
	Help        string `json:"help"`
}

// Setting describes one non-secret setting (http_settings).
type Setting struct {
	Key      string   `json:"key"`
	Label    string   `json:"label"`
	Type     string   `json:"type"`
	Default  any      `json:"default"`
	Options  []string `json:"options"`
	Required bool     `json:"required"`
	Help     string   `json:"help"`
}

// Info is one catalogue entry.
type Info struct {
	ID                   string       `json:"id"`
	Name                 string       `json:"name"`
	Country              string       `json:"country"`
	Website              string       `json:"website"`
	DocsURL              *string      `json:"docs_url"`
	Confidence           string       `json:"confidence"`
	Credentials          []Credential `json:"credentials"`
	Settings             []Setting    `json:"settings"`
	DLRMode              string       `json:"dlr_mode"`
	SupportsBalance      bool         `json:"supports_balance"`
	DestinationCountries []string     `json:"destination_countries"` // nil = any
	Notes                string       `json:"notes"`
}

// Credential returns the credential descriptor for key, or nil.
func (i *Info) Credential(key string) *Credential {
	for k := range i.Credentials {
		if i.Credentials[k].Key == key {
			return &i.Credentials[k]
		}
	}
	return nil
}

// Setting returns the setting descriptor for key, or nil.
func (i *Info) Setting(key string) *Setting {
	for k := range i.Settings {
		if i.Settings[k].Key == key {
			return &i.Settings[k]
		}
	}
	return nil
}

// Outcome classifies a provider call.
type Outcome int

const (
	Accepted Outcome = iota
	Rejected         // definitely not accepted: fail over
	Retry            // transient, nothing accepted: back off, retry on this connection
	Unknown          // may have been accepted: never resend
)

func (o Outcome) String() string {
	switch o {
	case Accepted:
		return "accepted"
	case Rejected:
		return "rejected"
	case Retry:
		return "retry"
	case Unknown:
		return "unknown"
	}
	return "?"
}

// Message is one message to send. To is E.164 digits without '+'.
type Message struct {
	ID          string // our message id (idempotency keys, fallback provider id)
	To          string
	Text        string
	Source      string // the message's sender (client / route forced)
	Encoding    string // GSM7 | UCS2
	Parts       int
	CallbackURL string // provider DLR callback URL for adapters that take one per request ("" = none)
}

// Exchange is one HTTP request/response pair (unmasked; mask with Conn.Mask
// before showing it).
type Exchange struct {
	Request  *Request
	Response *Response // nil when no response arrived
	Duration time.Duration
}

// SendResult is the classified result of Send.
type SendResult struct {
	Outcome     Outcome
	ProviderIDs []string // provider message ids (first = this message's); empty when the provider returns none
	// ErrorCode is the short code recorded as message_logs.error_code
	// (provider code like "1012" / "INSUFFICIENT_CREDITS", "HTTP_403",
	// SUBMIT_TIMEOUT / SUBMIT_UNKNOWN for ambiguous outcomes).
	ErrorCode string
	Error     string // human readable (masked)
	// RecipientError: the rejection is about this message's recipient or
	// content (invalid number, empty text), not the connection's health.
	RecipientError bool
	RetryAfter     time.Duration // provider asked to wait (429 Retry-After)
	HTTPStatus     int
	Exchange       *Exchange
}

// ProviderID returns the first provider id or "".
func (r *SendResult) ProviderID() string {
	if len(r.ProviderIDs) == 0 {
		return ""
	}
	return r.ProviderIDs[0]
}

// Pending is a submitted message whose final status a poller should fetch.
type Pending struct {
	MessageID  string
	ProviderID string
	CreatedAt  time.Time
}

// Receipt is a delivery status reported by the provider. Stat is the
// receipt word (DELIVRD, UNDELIV, EXPIRED, REJECTD, UNKNOWN), or "" for a
// non-final status (accepted, queued, sent...), which is ignored.
type Receipt struct {
	ProviderID string
	Stat       string
	Err        string // 3-digit dlr_err ("" = 000)
	Raw        string // provider status word
}

// Callback is a provider DLR callback forwarded by the api.
type Callback struct {
	Method  string            `json:"method"`
	Query   map[string]any    `json:"query"`
	Headers map[string]string `json:"headers"` // lowercased names
	Body    []byte            `json:"-"`
}

// QueryValue returns a query parameter as a string (first value of a list).
func (c *Callback) QueryValue(k string) string {
	switch v := c.Query[k].(type) {
	case string:
		return v
	case []any:
		if len(v) > 0 {
			if s, ok := v[0].(string); ok {
				return s
			}
		}
	}
	return ""
}

// BalanceResult is a provider balance query result.
type BalanceResult struct {
	Balance  string // as the provider reports it ("" = not found)
	Raw      string // response body (masked by the caller)
	Error    string
	Exchange *Exchange
}

// Adapter sends messages through one provider API.
type Adapter interface {
	Info() Info
	Send(ctx context.Context, c *Conn, m *Message) SendResult
}

// DLRPoller is implemented by adapters with dlr_mode "poll".
type DLRPoller interface {
	PollDLR(ctx context.Context, c *Conn, pending []Pending) ([]Receipt, error)
}

// CallbackParser is implemented by adapters with dlr_mode "callback".
// ErrBadSignature reports a callback whose signature does not verify.
type CallbackParser interface {
	ParseCallback(c *Conn, cb *Callback) ([]Receipt, error)
}

// BalanceChecker is implemented by adapters with supports_balance.
type BalanceChecker interface {
	Balance(ctx context.Context, c *Conn) BalanceResult
}

// DLRModer lets an adapter's effective DLR mode depend on the connection's
// settings (generic_http); others use Info().DLRMode.
type DLRModer interface {
	DLRMode(c *Conn) string
}

// --- registry ----------------------------------------------------------------

var registry = map[string]Adapter{}

func register(a Adapter) { registry[a.Info().ID] = a }

// Get returns the adapter with id, or nil.
func Get(id string) Adapter { return registry[id] }

// Catalogue returns every adapter's Info: Nepal adapters first in market
// relevance order, then generic_http.
func Catalogue() []Info {
	out := make([]Info, 0, len(registry))
	for _, a := range registry {
		out = append(out, a.Info())
	}
	sort.SliceStable(out, func(i, j int) bool { return rank(out[i].ID) < rank(out[j].ID) })
	return out
}

var order = []string{"sparrow_v2", "aakash_v3", "aakash_v4", "swift_smartsms", "messengernepal", "twozero",
	"nestsms", "bulletsms", "bitmoro", "generic_http"}

func rank(id string) int {
	for i, x := range order {
		if x == id {
			return i
		}
	}
	return len(order)
}

// EffectiveDLRMode is the adapter's DLR mode for connection c.
func EffectiveDLRMode(a Adapter, c *Conn) string {
	if d, ok := a.(DLRModer); ok {
		return d.DLRMode(c)
	}
	return a.Info().DLRMode
}

// AcceptsDestination reports whether the adapter can send to E.164 digits
// to (destination_countries; nil = any).
func AcceptsDestination(info *Info, to string) bool {
	if info.DestinationCountries == nil {
		return true
	}
	for _, cc := range info.DestinationCountries {
		if cc == "NP" && NepalLocal(to) != "" {
			return true
		}
	}
	return false
}

// --- connection --------------------------------------------------------------

// Conn is one HTTP connection as an adapter sees it.
type Conn struct {
	ID          string
	Credentials map[string]string
	Settings    Settings
	DLRToken    string
	Transport   Transport
	secrets     []string
}

// NewConn builds a Conn; info tells which credential values are secret.
func NewConn(id string, info *Info, creds map[string]string, settings map[string]any, dlrToken string, t Transport) *Conn {
	c := &Conn{ID: id, Credentials: creds, Settings: Settings(settings), DLRToken: dlrToken, Transport: t}
	if c.Credentials == nil {
		c.Credentials = map[string]string{}
	}
	if c.Settings == nil {
		c.Settings = Settings{}
	}
	for k, v := range c.Credentials {
		cd := info.Credential(k)
		if (cd == nil || cd.Secret) && v != "" {
			c.secrets = append(c.secrets, v)
		}
	}
	// Longest first so a secret containing another is masked whole.
	sort.Slice(c.secrets, func(i, j int) bool { return len(c.secrets[i]) > len(c.secrets[j]) })
	return c
}

// Cred returns a credential value ("" when unset).
func (c *Conn) Cred(k string) string { return strings.TrimSpace(c.Credentials[k]) }

// Mask replaces every secret credential value (raw, URL-, JSON- and
// base64-encoded forms) in s with "***".
func (c *Conn) Mask(s string) string { return maskSecrets(s, c.secrets) }

// MaskRequest returns a copy of r with secrets masked (and auth headers
// replaced).
func (c *Conn) MaskRequest(r *Request) *Request {
	if r == nil {
		return nil
	}
	out := &Request{Method: r.Method, URL: c.Mask(r.URL), Body: []byte(c.Mask(string(r.Body))), Header: http.Header{}}
	for k, vs := range r.Header {
		for _, v := range vs {
			switch strings.ToLower(k) {
			case "authorization":
				if i := strings.IndexByte(v, ' '); i > 0 {
					v = v[:i] + " ***"
				} else {
					v = "***"
				}
			default:
				v = c.Mask(v)
			}
			out.Header.Add(k, v)
		}
	}
	return out
}

// do performs one request through the connection's transport and records
// the exchange.
func (c *Conn) do(ctx context.Context, r *Request) (*Response, *Exchange, error) {
	start := time.Now()
	resp, err := c.Transport.Do(ctx, r)
	return resp, &Exchange{Request: r, Response: resp, Duration: time.Since(start)}, err
}

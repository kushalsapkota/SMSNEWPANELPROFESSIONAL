package store

import (
	"net/netip"
	"regexp"
	"time"

	"smsgw/engine/internal/otp"
)

// All IDs are canonical lowercase hyphenated UUID strings (Postgres
// uuid::text). Values reachable from a *Snapshot are shared and MUST be
// treated as read-only.

// Org roles.
const (
	RoleSuperAdmin = "SUPER_ADMIN"
	RoleReseller   = "RESELLER"
	RoleClient     = "CLIENT"
)

// Message channels (msg_channel enum).
const (
	ChannelHTTP = "HTTP"
	ChannelSMPP = "SMPP"
	ChannelWeb  = "WEB"
)

// IP whitelist scopes (ip_scope enum).
const (
	ScopeAPI   = "API"
	ScopeSMPP  = "SMPP"
	ScopePanel = "PANEL"
	ScopeAll   = "ALL"
)

// Effective is app.org_effective_state for one org (reseller state folded
// into the client's), plus CanWeb which the view does not provide.
type Effective struct {
	IsActive        bool
	CanSend         bool
	CanAPI          bool
	CanSMPP         bool
	CanWeb          bool // can_send AND web_enabled on org and its reseller
	EffectiveMaxTPS int
}

// Account is the org's accounts_balance row (limits/mode). BalanceMicros is
// the Postgres snapshot at load time — NOT authoritative while the balance
// is loaded in Redis; use billing for live balances.
type Account struct {
	BillingMode           string // PREPAID | POSTPAID
	BalanceMicros         int64
	CreditLimitMicros     int64
	Currency              string
	LowBalanceAlertMicros *int64
}

// OverdraftLimit is the Redis "limit" field: credit limit for POSTPAID, else 0.
func (a *Account) OverdraftLimit() int64 {
	if a == nil || a.BillingMode != "POSTPAID" {
		return 0
	}
	return a.CreditLimitMicros
}

// Org is an organizations row.
type Org struct {
	ID              string
	Role            string
	ParentID        string // "" for SUPER_ADMIN
	Name            string
	Status          string // ACTIVE | SUSPENDED | CLOSED
	SuspendedReason string
	SendingEnabled  bool
	APIEnabled      bool
	SMPPEnabled     bool
	WebEnabled      bool
	MaxTPS          int
	DailyLimit      int // 0 = unlimited
	MonthlyLimit    int // 0 = unlimited
	BrandName       string
	Timezone        string
	UpdatedAt       time.Time

	Effective Effective
	Account   *Account // nil when the org has no accounts_balance row
}

// CanUseChannel reports the effective permission for a submission channel
// (CONTRACTS §9 step 1): HTTP needs can_api, SMPP can_smpp, WEB can_web.
func (o *Org) CanUseChannel(ch string) bool {
	switch ch {
	case ChannelHTTP:
		return o.Effective.CanAPI
	case ChannelSMPP:
		return o.Effective.CanSMPP
	case ChannelWeb:
		return o.Effective.CanWeb
	}
	return false
}

// Rate is the currently effective upstream_rates row for a (connection, prefix).
type Rate struct {
	ID            string
	ConnectionID  string
	Prefix        string
	CostMicros    int64
	EffectiveFrom time.Time
}

// Connection is an upstream_connections row with the decrypted password.
type Connection struct {
	ID                  string
	Name                string
	Host                string
	Port                int
	UseTLS              bool
	SystemID            string
	Password            string // decrypted; "" when PasswordErr != nil
	PasswordErr         error  // decryption failure (connection should not be bound)
	SystemType          string
	BindType            string // TX | RX | TRX
	Sessions            int
	MaxTPS              int
	WindowSize          int
	EnquireLinkInterval time.Duration
	ReconnectMin        time.Duration
	ReconnectMax        time.Duration
	SubmitTimeout       time.Duration
	RequestDLR          bool
	MultipartMode       string // UDH | SAR | PAYLOAD
	DefaultDataCoding   int
	Enabled             bool
	Notes               string
	UpdatedAt           time.Time

	// Rates sorted by prefix length descending (longest-prefix first).
	Rates []*Rate
}

// SessionConfigEqual reports whether two connections would bind identically:
// only the fields that require the sessions to be rebound (address, TLS,
// credentials, bind parameters, session count and timers, enabled). Fields
// read per message from the snapshot (name, request_dlr, multipart_mode,
// default_data_coding) or applied in place (max_tps) are not compared, so
// editing them never unbinds the SMSC sessions.
func (c *Connection) SessionConfigEqual(o *Connection) bool {
	if c == nil || o == nil {
		return c == o
	}
	return c.Host == o.Host && c.Port == o.Port && c.UseTLS == o.UseTLS &&
		c.SystemID == o.SystemID && c.Password == o.Password && (c.PasswordErr == nil) == (o.PasswordErr == nil) &&
		c.SystemType == o.SystemType && c.BindType == o.BindType && c.Sessions == o.Sessions &&
		c.WindowSize == o.WindowSize && c.EnquireLinkInterval == o.EnquireLinkInterval &&
		c.ReconnectMin == o.ReconnectMin && c.ReconnectMax == o.ReconnectMax && c.SubmitTimeout == o.SubmitTimeout &&
		c.Enabled == o.Enabled
}

// ConfigEqual reports whether every operational field is equal (session
// fields plus name, max_tps, request_dlr, multipart_mode and
// default_data_coding; notes, rates and timestamps are ignored).
func (c *Connection) ConfigEqual(o *Connection) bool {
	if !c.SessionConfigEqual(o) {
		return false
	}
	if c == nil {
		return true
	}
	return c.Name == o.Name && c.MaxTPS == o.MaxTPS && c.RequestDLR == o.RequestDLR &&
		c.MultipartMode == o.MultipartMode && c.DefaultDataCoding == o.DefaultDataCoding
}

// RouteConnection is a route_connections row joined to its connection
// (Connection is nil if the referenced connection is missing).
type RouteConnection struct {
	RouteID      string
	ConnectionID string
	Priority     int
	Weight       int
	Enabled      bool
	Connection   *Connection
}

// Usable reports whether this leg can carry traffic: enabled link to an
// enabled connection with a decryptable password.
func (rc *RouteConnection) Usable() bool {
	return rc.Enabled && rc.Connection != nil && rc.Connection.Enabled && rc.Connection.PasswordErr == nil
}

// Route is a routes row with its connections sorted by priority, then
// connection id.
type Route struct {
	ID               string
	Name             string
	Description      string
	Enabled          bool
	TemplateMode     bool
	TemplateFallback otp.Action // REJECT | SEND_RAW | SEND_DEFAULT_TEMPLATE
	ForceSenderID    string     // "" = none
	Connections      []*RouteConnection
}

// HasUsableConnection reports whether at least one leg is usable.
func (r *Route) HasUsableConnection() bool {
	for _, rc := range r.Connections {
		if rc.Usable() {
			return true
		}
	}
	return false
}

// Assignment is an org_route_assignments row.
type Assignment struct {
	ID         string
	OrgID      string
	RouteID    string
	Prefix     string // "" = all destinations
	RateMicros int64  // per segment
	Priority   int
	Enabled    bool
}

// Template is an active route_templates row. Template.Template is ready to
// pass to otp.Resolve. PatternErr is set when a pattern does not compile.
type Template struct {
	ID         string
	RouteID    string
	OrgID      string // "" = route-wide default
	Name       string
	PatternErr error
	otp.Template
}

// SenderID is a sender_ids row.
type SenderID struct {
	ID      string
	OrgID   string
	RouteID string // "" = any route
	Sender  string
	Status  string // PENDING | APPROVED | REJECTED
}

// SMPPAccount is a smpp_accounts row.
type SMPPAccount struct {
	ID               string
	OrgID            string
	SystemID         string
	PasswordHash     string
	AllowedBindTypes []string // TX | RX | TRX
	MaxBinds         int
	MaxTPS           int // 0 = use the org's effective max TPS
	Enabled          bool
}

// AllowsBind reports whether bindType (TX|RX|TRX) is permitted.
func (a *SMPPAccount) AllowsBind(bindType string) bool {
	for _, b := range a.AllowedBindTypes {
		if b == bindType {
			return true
		}
	}
	return false
}

// IPRule is an ip_whitelists row.
type IPRule struct {
	ID     string
	OrgID  string
	Prefix netip.Prefix
	Scope  string
}

// Webhook is a webhooks row with the decrypted signing secret.
type Webhook struct {
	ID           string
	OrgID        string
	URL          string
	Secret       string
	SecretErr    error // decryption failure: deliveries cannot be signed
	Events       []string
	MaxRetries   int
	Enabled      bool
	FailureCount int
}

// Subscribed reports whether the webhook wants event.
func (w *Webhook) Subscribed(event string) bool {
	for _, e := range w.Events {
		if e == event {
			return true
		}
	}
	return false
}

// BlockedNumber is a blocked_numbers row (OrgID "" = global).
type BlockedNumber struct {
	ID     string
	OrgID  string
	Prefix string
}

// BlockedKeyword is a blocked_keywords row (OrgID "" = global), compiled
// case-insensitively. Re is nil when the pattern is invalid (it is then
// ignored and reported in Snapshot.Warnings).
type BlockedKeyword struct {
	ID      string
	OrgID   string
	Pattern string
	Re      *regexp.Regexp
}

// Data is the raw content of a snapshot, as loaded from Postgres (or built
// by tests). NewSnapshot indexes it.
type Data struct {
	Orgs             []*Org
	Routes           []*Route // Connections filled from RouteConnections by NewSnapshot
	RouteConnections []*RouteConnection
	Connections      []*Connection // Rates filled from Rates by NewSnapshot
	Rates            []*Rate
	Assignments      []*Assignment
	Templates        []*Template
	SenderIDs        []*SenderID
	SMPPAccounts     []*SMPPAccount
	IPRules          []*IPRule
	Webhooks         []*Webhook
	BlockedNumbers   []*BlockedNumber
	BlockedKeywords  []*BlockedKeyword
	LoadedAt         time.Time
	Warnings         []string
}

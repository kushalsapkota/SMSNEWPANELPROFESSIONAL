package store

import (
	"fmt"
	"net/netip"
	"sort"
	"strings"
	"time"

	"smsgw/engine/internal/otp"
)

// Snapshot is an immutable, fully indexed view of all engine configuration.
// It is safe for concurrent use; obtain the current one from Store.Current
// and keep using the same pointer for the duration of one request so all
// lookups are mutually consistent.
type Snapshot struct {
	// Version increases by one on every successful reload (0 for snapshots
	// built directly with NewSnapshot).
	Version  uint64
	LoadedAt time.Time
	// Warnings lists non-fatal problems found while building the snapshot
	// (undecryptable secrets, invalid regexes, bad CIDRs, dangling refs).
	Warnings []string

	orgs        map[string]*Org
	children    map[string][]*Org
	routes      map[string]*Route
	connections map[string]*Connection
	assignments map[string][]*Assignment // org -> sorted
	templates   map[string]map[string]*Template
	senders     map[string][]*SenderID
	smppBySys   map[string]*SMPPAccount
	smppByOrg   map[string][]*SMPPAccount
	ipRules     map[string][]*IPRule
	webhooks    map[string][]*Webhook
	blockedNums map[string]map[string]struct{} // scope org ("" global) -> prefixes
	keywords    map[string][]*BlockedKeyword   // scope org ("" global) -> compiled
	maxBlockLen int

	data Data
}

// NewSnapshot indexes d. It takes ownership of d (it fills Route.Connections,
// Connection.Rates and Org.Effective.CanWeb) — do not mutate d afterwards.
func NewSnapshot(d Data) *Snapshot {
	s := &Snapshot{
		LoadedAt:    d.LoadedAt,
		Warnings:    append([]string(nil), d.Warnings...),
		orgs:        make(map[string]*Org, len(d.Orgs)),
		children:    make(map[string][]*Org),
		routes:      make(map[string]*Route, len(d.Routes)),
		connections: make(map[string]*Connection, len(d.Connections)),
		assignments: make(map[string][]*Assignment),
		templates:   make(map[string]map[string]*Template),
		senders:     make(map[string][]*SenderID),
		smppBySys:   make(map[string]*SMPPAccount, len(d.SMPPAccounts)),
		smppByOrg:   make(map[string][]*SMPPAccount),
		ipRules:     make(map[string][]*IPRule),
		webhooks:    make(map[string][]*Webhook),
		blockedNums: make(map[string]map[string]struct{}),
		keywords:    make(map[string][]*BlockedKeyword),
	}
	if s.LoadedAt.IsZero() {
		s.LoadedAt = time.Now()
	}
	warn := func(format string, args ...any) { s.Warnings = append(s.Warnings, fmt.Sprintf(format, args...)) }

	for _, o := range d.Orgs {
		s.orgs[o.ID] = o
	}
	for _, o := range d.Orgs {
		if o.ParentID != "" {
			s.children[o.ParentID] = append(s.children[o.ParentID], o)
		}
		// app.org_effective_state has no can_web; derive it the same way.
		canWeb := o.Effective.CanSend && o.WebEnabled
		if p := s.orgs[o.ParentID]; p != nil && p.Role == RoleReseller {
			canWeb = canWeb && p.WebEnabled
		}
		o.Effective.CanWeb = canWeb
	}
	for _, kids := range s.children {
		sort.Slice(kids, func(i, j int) bool { return kids[i].ID < kids[j].ID })
	}

	for _, c := range d.Connections {
		c.Rates = nil
		s.connections[c.ID] = c
		if c.PasswordErr != nil {
			warn("upstream connection %s (%s): password: %v", c.ID, c.Name, c.PasswordErr)
		}
	}
	for _, r := range d.Rates {
		c := s.connections[r.ConnectionID]
		if c == nil {
			continue
		}
		c.Rates = append(c.Rates, r)
	}
	for _, c := range s.connections {
		sort.Slice(c.Rates, func(i, j int) bool {
			if len(c.Rates[i].Prefix) != len(c.Rates[j].Prefix) {
				return len(c.Rates[i].Prefix) > len(c.Rates[j].Prefix)
			}
			return c.Rates[i].Prefix < c.Rates[j].Prefix
		})
	}

	for _, r := range d.Routes {
		r.Connections = nil
		s.routes[r.ID] = r
	}
	for _, rc := range d.RouteConnections {
		r := s.routes[rc.RouteID]
		if r == nil {
			continue
		}
		rc.Connection = s.connections[rc.ConnectionID]
		if rc.Connection == nil {
			warn("route %s references unknown connection %s", rc.RouteID, rc.ConnectionID)
		}
		r.Connections = append(r.Connections, rc)
	}
	for _, r := range s.routes {
		sort.Slice(r.Connections, func(i, j int) bool {
			a, b := r.Connections[i], r.Connections[j]
			if a.Priority != b.Priority {
				return a.Priority < b.Priority
			}
			return a.ConnectionID < b.ConnectionID
		})
	}

	for _, a := range d.Assignments {
		s.assignments[a.OrgID] = append(s.assignments[a.OrgID], a)
	}
	for _, list := range s.assignments {
		sort.Slice(list, func(i, j int) bool { return assignmentLess(list[i], list[j]) })
	}

	for _, t := range d.Templates {
		if t.PatternErr == nil {
			t.PatternErr = otp.ValidatePatterns(t.Patterns)
		}
		if t.PatternErr != nil {
			warn("route template %s: %v", t.ID, t.PatternErr)
		}
		m := s.templates[t.RouteID]
		if m == nil {
			m = make(map[string]*Template)
			s.templates[t.RouteID] = m
		}
		m[t.OrgID] = t
	}

	for _, sid := range d.SenderIDs {
		s.senders[sid.OrgID] = append(s.senders[sid.OrgID], sid)
	}
	for _, a := range d.SMPPAccounts {
		s.smppBySys[a.SystemID] = a
		s.smppByOrg[a.OrgID] = append(s.smppByOrg[a.OrgID], a)
	}
	for _, r := range d.IPRules {
		s.ipRules[r.OrgID] = append(s.ipRules[r.OrgID], r)
	}
	for _, w := range d.Webhooks {
		s.webhooks[w.OrgID] = append(s.webhooks[w.OrgID], w)
		if w.SecretErr != nil {
			warn("webhook %s: secret: %v", w.ID, w.SecretErr)
		}
	}
	for _, b := range d.BlockedNumbers {
		m := s.blockedNums[b.OrgID]
		if m == nil {
			m = make(map[string]struct{})
			s.blockedNums[b.OrgID] = m
		}
		m[b.Prefix] = struct{}{}
		if len(b.Prefix) > s.maxBlockLen {
			s.maxBlockLen = len(b.Prefix)
		}
	}
	for _, k := range d.BlockedKeywords {
		if k.Re == nil {
			re, err := compileKeyword(k.Pattern)
			if err != nil {
				warn("blocked keyword %s %q: %v (ignored)", k.ID, k.Pattern, err)
				continue
			}
			k.Re = re
		}
		s.keywords[k.OrgID] = append(s.keywords[k.OrgID], k)
	}
	s.data = d
	return s
}

func assignmentLess(a, b *Assignment) bool {
	if len(a.Prefix) != len(b.Prefix) {
		return len(a.Prefix) > len(b.Prefix)
	}
	if a.Priority != b.Priority {
		return a.Priority < b.Priority
	}
	if a.RouteID != b.RouteID {
		return a.RouteID < b.RouteID
	}
	return a.ID < b.ID
}

// Data returns the raw data the snapshot was built from (read-only).
func (s *Snapshot) Data() *Data { return &s.data }

// Org returns the org or nil.
func (s *Snapshot) Org(id string) *Org { return s.orgs[id] }

// Parent returns the org's parent or nil.
func (s *Snapshot) Parent(id string) *Org {
	o := s.orgs[id]
	if o == nil || o.ParentID == "" {
		return nil
	}
	return s.orgs[o.ParentID]
}

// Reseller returns the reseller responsible for org id: the parent for a
// CLIENT, the org itself for a RESELLER, nil for SUPER_ADMIN / unknown.
func (s *Snapshot) Reseller(id string) *Org {
	o := s.orgs[id]
	if o == nil {
		return nil
	}
	switch o.Role {
	case RoleReseller:
		return o
	case RoleClient:
		if p := s.orgs[o.ParentID]; p != nil && p.Role == RoleReseller {
			return p
		}
	}
	return nil
}

// BalanceTag returns the CONTRACTS §7 hash tag for org id (reseller id);
// ok=false for SUPER_ADMIN or unknown orgs (never billed).
func (s *Snapshot) BalanceTag(id string) (string, bool) {
	r := s.Reseller(id)
	if r == nil {
		return "", false
	}
	return r.ID, true
}

// Children returns the direct children of org id, sorted by id.
func (s *Snapshot) Children(id string) []*Org { return s.children[id] }

// Orgs returns all orgs sorted by id.
func (s *Snapshot) Orgs() []*Org {
	out := make([]*Org, 0, len(s.orgs))
	for _, o := range s.orgs {
		out = append(out, o)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Brand returns the {brand} value for org id: its brand_name, else its
// reseller's brand_name, else "". (A template's own brand takes precedence;
// otp.Resolve applies that.)
func (s *Snapshot) Brand(id string) string {
	o := s.orgs[id]
	if o == nil {
		return ""
	}
	if o.BrandName != "" {
		return o.BrandName
	}
	if r := s.Reseller(id); r != nil && r != o {
		return r.BrandName
	}
	return ""
}

// Route returns the route or nil.
func (s *Snapshot) Route(id string) *Route { return s.routes[id] }

// Routes returns all routes sorted by name.
func (s *Snapshot) Routes() []*Route {
	out := make([]*Route, 0, len(s.routes))
	for _, r := range s.routes {
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// Connection returns the upstream connection or nil.
func (s *Snapshot) Connection(id string) *Connection { return s.connections[id] }

// Connections returns all upstream connections sorted by id.
func (s *Snapshot) Connections() []*Connection {
	out := make([]*Connection, 0, len(s.connections))
	for _, c := range s.connections {
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Assignments returns every route assignment of org id (enabled or not),
// sorted by prefix length desc, then priority asc, then route id.
func (s *Snapshot) Assignments(orgID string) []*Assignment { return s.assignments[orgID] }

// EffectiveTemplate returns the active template for (route, client):
// the client override if any, else the route-wide default, else nil.
func (s *Snapshot) EffectiveTemplate(routeID, orgID string) *Template {
	m := s.templates[routeID]
	if m == nil {
		return nil
	}
	if orgID != "" {
		if t := m[orgID]; t != nil {
			return t
		}
	}
	return m[""]
}

// SenderIDs returns the sender_ids rows of org id.
func (s *Snapshot) SenderIDs(orgID string) []*SenderID { return s.senders[orgID] }

// SenderAllowed applies CONTRACTS §9 step 5 (without force_sender_id, which
// the caller applies first): an org with no sender_ids rows may use any
// sender (restricted=false); otherwise source must match an APPROVED row
// whose route is routeID or NULL. Numeric senders compare digits (a leading
// '+' is ignored); alphanumeric senders compare case-insensitively.
func (s *Snapshot) SenderAllowed(orgID, routeID, source string) (allowed, restricted bool) {
	rows := s.senders[orgID]
	if len(rows) == 0 {
		return true, false
	}
	want := normalizeSender(source)
	for _, r := range rows {
		if r.Status != "APPROVED" || (r.RouteID != "" && r.RouteID != routeID) {
			continue
		}
		if strings.EqualFold(normalizeSender(r.Sender), want) {
			return true, true
		}
	}
	return false, true
}

func normalizeSender(s string) string {
	s = strings.TrimSpace(s)
	if d := strings.TrimPrefix(s, "+"); d != "" && isDigits(d) {
		return d
	}
	return s
}

func isDigits(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// SMPPAccount returns the account with system_id sid, or nil.
func (s *Snapshot) SMPPAccount(sid string) *SMPPAccount { return s.smppBySys[sid] }

// SMPPAccounts returns the SMPP accounts of org id.
func (s *Snapshot) SMPPAccounts(orgID string) []*SMPPAccount { return s.smppByOrg[orgID] }

// IPRules returns org id's whitelist rows.
func (s *Snapshot) IPRules(orgID string) []*IPRule { return s.ipRules[orgID] }

// IPAllowed mirrors app.ip_allowed(org, ip, scope): if the org has no rows
// for scope or ALL, every IP is allowed; otherwise ip must fall inside one
// of those rows. IPv4-mapped IPv6 addresses are unmapped first. An invalid
// address is never allowed when rules exist.
func (s *Snapshot) IPAllowed(orgID string, ip netip.Addr, scope string) bool {
	any := false
	ip = ip.Unmap()
	for _, r := range s.ipRules[orgID] {
		if r.Scope != scope && r.Scope != ScopeAll {
			continue
		}
		any = true
		if ip.IsValid() && r.Prefix.Contains(ip) {
			return true
		}
	}
	return !any
}

// IPAllowedString parses ip (with optional port / zone) and calls IPAllowed.
func (s *Snapshot) IPAllowedString(orgID, ip, scope string) bool {
	addr, err := netip.ParseAddr(stripPort(ip))
	if err != nil {
		addr = netip.Addr{}
	}
	return s.IPAllowed(orgID, addr, scope)
}

func stripPort(hostport string) string {
	if ap, err := netip.ParseAddrPort(hostport); err == nil {
		return ap.Addr().String()
	}
	return strings.Trim(hostport, "[]")
}

// Webhooks returns all webhooks of org id.
func (s *Snapshot) Webhooks(orgID string) []*Webhook { return s.webhooks[orgID] }

// WebhooksFor returns the enabled, signable webhooks of org id subscribed to event.
func (s *Snapshot) WebhooksFor(orgID, event string) []*Webhook {
	var out []*Webhook
	for _, w := range s.webhooks[orgID] {
		if w.Enabled && w.SecretErr == nil && w.Subscribed(event) {
			out = append(out, w)
		}
	}
	return out
}

// blockScopes returns the blocklist scopes that apply to org id: global,
// its reseller's (for a client) and its own.
func (s *Snapshot) blockScopes(orgID string) []string {
	scopes := []string{""}
	if r := s.Reseller(orgID); r != nil && r.ID != orgID {
		scopes = append(scopes, r.ID)
	}
	if orgID != "" {
		scopes = append(scopes, orgID)
	}
	return scopes
}

// NumberBlocked reports whether msisdn (normalized digits) matches a
// blocked_numbers prefix in the global, reseller or org scope. It returns
// the matching scope org id ("" = global) and prefix.
func (s *Snapshot) NumberBlocked(orgID, msisdn string) (blocked bool, scopeOrgID, prefix string) {
	n := len(msisdn)
	if n > s.maxBlockLen {
		n = s.maxBlockLen
	}
	for _, scope := range s.blockScopes(orgID) {
		m := s.blockedNums[scope]
		if len(m) == 0 {
			continue
		}
		for l := 1; l <= n; l++ {
			if _, ok := m[msisdn[:l]]; ok {
				return true, scope, msisdn[:l]
			}
		}
	}
	return false, "", ""
}

// ContentBlocked returns the first blocked keyword (global, reseller, org
// scope) matching text, or nil.
func (s *Snapshot) ContentBlocked(orgID, text string) *BlockedKeyword {
	for _, scope := range s.blockScopes(orgID) {
		for _, k := range s.keywords[scope] {
			if k.Re.MatchString(text) {
				return k
			}
		}
	}
	return nil
}

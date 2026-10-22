package store

import (
	"context"
	"encoding/json"
	"fmt"
	"net/netip"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5"

	"smsgw/engine/internal/crypto"
	"smsgw/engine/internal/otp"
)

// compileKeyword compiles a blocked_keywords pattern (RE2, case-insensitive).
func compileKeyword(p string) (*regexp.Regexp, error) {
	return regexp.Compile("(?i)" + p)
}

// querier is satisfied by pgx.Tx, *pgx.Conn and *pgxpool.Pool.
type querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// LoadData reads every config table in one REPEATABLE READ, read-only
// transaction (a consistent point-in-time view) and decrypts secrets with
// cipher. Per-row problems (undecryptable secret, bad CIDR) are recorded as
// warnings and never fail the load; database errors do.
func LoadData(ctx context.Context, db interface {
	BeginTx(ctx context.Context, opts pgx.TxOptions) (pgx.Tx, error)
}, cipher *crypto.Cipher) (*Data, error) {
	tx, err := db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, fmt.Errorf("store: begin: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // read-only

	d := &Data{}
	var now time.Time
	if err := tx.QueryRow(ctx, `SELECT now()`).Scan(&now); err != nil {
		return nil, fmt.Errorf("store: now: %w", err)
	}
	d.LoadedAt = now
	steps := []struct {
		name string
		fn   func(context.Context, querier, *Data, *crypto.Cipher) error
	}{
		{"organizations", loadOrgs},
		{"upstream_connections", loadConnections},
		{"upstream_rates", loadRates},
		{"routes", loadRoutes},
		{"route_connections", loadRouteConnections},
		{"org_route_assignments", loadAssignments},
		{"route_templates", loadTemplates},
		{"sender_ids", loadSenderIDs},
		{"approved_content", loadApprovedContent},
		{"smpp_accounts", loadSMPPAccounts},
		{"ip_whitelists", loadIPRules},
		{"webhooks", loadWebhooks},
		{"blocked_numbers", loadBlockedNumbers},
		{"blocked_keywords", loadBlockedKeywords},
		{"service_switches", loadSwitches},
	}
	for _, st := range steps {
		if err := st.fn(ctx, tx, d, cipher); err != nil {
			return nil, fmt.Errorf("store: load %s: %w", st.name, err)
		}
	}
	return d, nil
}

func loadOrgs(ctx context.Context, q querier, d *Data, _ *crypto.Cipher) error {
	rows, err := q.Query(ctx, `
		SELECT o.id::text, o.role::text, coalesce(o.parent_id::text, ''), o.name, o.status::text,
		       coalesce(o.suspended_reason, ''), o.sending_enabled, o.api_enabled, o.smpp_enabled,
		       o.web_enabled, o.content_approval_required, o.max_tps, coalesce(o.daily_limit, 0), coalesce(o.monthly_limit, 0),
		       coalesce(o.brand_name, ''), o.timezone, o.updated_at,
		       e.is_active, e.can_send, e.can_api, e.can_smpp, e.effective_max_tps,
		       ab.org_id IS NOT NULL, coalesce(ab.billing_mode::text, ''), coalesce(ab.balance_micros, 0),
		       coalesce(ab.credit_limit_micros, 0), coalesce(ab.currency, ''), ab.low_balance_alert_micros
		  FROM organizations o
		  JOIN app.org_effective_state e ON e.id = o.id
		  LEFT JOIN accounts_balance ab ON ab.org_id = o.id`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		o := &Org{}
		var hasAcct bool
		a := &Account{}
		if err := rows.Scan(&o.ID, &o.Role, &o.ParentID, &o.Name, &o.Status, &o.SuspendedReason,
			&o.SendingEnabled, &o.APIEnabled, &o.SMPPEnabled, &o.WebEnabled, &o.ContentApprovalRequired, &o.MaxTPS,
			&o.DailyLimit, &o.MonthlyLimit, &o.BrandName, &o.Timezone, &o.UpdatedAt,
			&o.Effective.IsActive, &o.Effective.CanSend, &o.Effective.CanAPI, &o.Effective.CanSMPP,
			&o.Effective.EffectiveMaxTPS, &hasAcct, &a.BillingMode, &a.BalanceMicros,
			&a.CreditLimitMicros, &a.Currency, &a.LowBalanceAlertMicros); err != nil {
			return err
		}
		if hasAcct {
			o.Account = a
		}
		d.Orgs = append(d.Orgs, o)
	}
	return rows.Err()
}

func loadConnections(ctx context.Context, q querier, d *Data, c *crypto.Cipher) error {
	rows, err := q.Query(ctx, `
		SELECT id::text, name, coalesce(host, ''), coalesce(port, 0), use_tls, coalesce(system_id, ''),
		       coalesce(password_enc, ''), system_type,
		       bind_type::text, sessions, max_tps, window_size, enquire_link_interval_s,
		       reconnect_min_s, reconnect_max_s, submit_timeout_ms, request_dlr, multipart_mode,
		       default_data_coding, enabled, coalesce(notes, ''), updated_at,
		       kind, coalesce(adapter, ''), coalesce(http_credentials_enc, ''), http_settings::text,
		       coalesce(dlr_token, '')
		  FROM upstream_connections`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		x := &Connection{}
		var enc, credEnc string
		var enq, rmin, rmax, subMS int
		if err := rows.Scan(&x.ID, &x.Name, &x.Host, &x.Port, &x.UseTLS, &x.SystemID, &enc,
			&x.SystemType, &x.BindType, &x.Sessions, &x.MaxTPS, &x.WindowSize, &enq, &rmin, &rmax,
			&subMS, &x.RequestDLR, &x.MultipartMode, &x.DefaultDataCoding, &x.Enabled, &x.Notes,
			&x.UpdatedAt, &x.Kind, &x.Adapter, &credEnc, &x.HTTPSettingsRaw, &x.DLRToken); err != nil {
			return err
		}
		x.EnquireLinkInterval = time.Duration(enq) * time.Second
		x.ReconnectMin = time.Duration(rmin) * time.Second
		x.ReconnectMax = time.Duration(rmax) * time.Second
		x.SubmitTimeout = time.Duration(subMS) * time.Millisecond
		if x.IsHTTP() {
			decodeHTTP(x, credEnc, c)
		} else if c == nil {
			x.PasswordErr = fmt.Errorf("no APP_ENC_KEY configured")
		} else if pw, err := c.DecryptString(enc); err != nil {
			x.PasswordErr = err
		} else {
			x.Password = pw
		}
		d.Connections = append(d.Connections, x)
	}
	return rows.Err()
}

// decodeHTTP fills the HTTP fields of x: settings (a JSON object; anything
// else is ignored with an empty map) and the decrypted credentials (a JSON
// object of key -> value; non-string values are kept in their JSON text).
// A credentials problem is recorded in PasswordErr, which makes the
// connection unusable, exactly like an undecryptable SMPP password.
func decodeHTTP(x *Connection, credEnc string, c *crypto.Cipher) {
	x.HTTPSettings = map[string]any{}
	if x.HTTPSettingsRaw != "" {
		var m map[string]any
		if json.Unmarshal([]byte(x.HTTPSettingsRaw), &m) == nil && m != nil {
			x.HTTPSettings = m
		}
	}
	x.HTTPCredentials = map[string]string{}
	if c == nil {
		x.PasswordErr = fmt.Errorf("no APP_ENC_KEY configured")
		return
	}
	plain, err := c.DecryptString(credEnc)
	if err != nil {
		x.PasswordErr = fmt.Errorf("http credentials: %w", err)
		return
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal([]byte(plain), &raw); err != nil {
		x.PasswordErr = fmt.Errorf("http credentials: not a JSON object")
		return
	}
	for k, v := range raw {
		var s string
		if json.Unmarshal(v, &s) == nil {
			x.HTTPCredentials[k] = s
		} else if string(v) != "null" {
			x.HTTPCredentials[k] = string(v)
		}
	}
}

// loadRates keeps, per (connection, prefix), the latest row already in
// effect. Future-dated rates become visible on the first reload after
// effective_from (at most ENGINE_CONFIG_RELOAD_INTERVAL later).
func loadRates(ctx context.Context, q querier, d *Data, _ *crypto.Cipher) error {
	rows, err := q.Query(ctx, `
		SELECT DISTINCT ON (connection_id, prefix)
		       id::text, connection_id::text, prefix, cost_micros, effective_from
		  FROM upstream_rates
		 WHERE effective_from <= now()
		 ORDER BY connection_id, prefix, effective_from DESC`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		r := &Rate{}
		if err := rows.Scan(&r.ID, &r.ConnectionID, &r.Prefix, &r.CostMicros, &r.EffectiveFrom); err != nil {
			return err
		}
		d.Rates = append(d.Rates, r)
	}
	return rows.Err()
}

func loadRoutes(ctx context.Context, q querier, d *Data, _ *crypto.Cipher) error {
	rows, err := q.Query(ctx, `
		SELECT id::text, name, coalesce(description, ''), enabled, template_mode,
		       template_fallback::text, coalesce(force_sender_id, '')
		  FROM routes`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		r := &Route{}
		var fb string
		if err := rows.Scan(&r.ID, &r.Name, &r.Description, &r.Enabled, &r.TemplateMode, &fb, &r.ForceSenderID); err != nil {
			return err
		}
		r.TemplateFallback = otp.Action(fb)
		d.Routes = append(d.Routes, r)
	}
	return rows.Err()
}

func loadRouteConnections(ctx context.Context, q querier, d *Data, _ *crypto.Cipher) error {
	rows, err := q.Query(ctx, `SELECT route_id::text, connection_id::text, priority, weight, enabled FROM route_connections`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		rc := &RouteConnection{}
		if err := rows.Scan(&rc.RouteID, &rc.ConnectionID, &rc.Priority, &rc.Weight, &rc.Enabled); err != nil {
			return err
		}
		d.RouteConnections = append(d.RouteConnections, rc)
	}
	return rows.Err()
}

func loadAssignments(ctx context.Context, q querier, d *Data, _ *crypto.Cipher) error {
	rows, err := q.Query(ctx, `
		SELECT id::text, org_id::text, route_id::text, prefix, rate_micros, priority, enabled
		  FROM org_route_assignments`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		a := &Assignment{}
		if err := rows.Scan(&a.ID, &a.OrgID, &a.RouteID, &a.Prefix, &a.RateMicros, &a.Priority, &a.Enabled); err != nil {
			return err
		}
		d.Assignments = append(d.Assignments, a)
	}
	return rows.Err()
}

func loadTemplates(ctx context.Context, q querier, d *Data, _ *crypto.Cipher) error {
	rows, err := q.Query(ctx, `
		SELECT id::text, route_id::text, coalesce(org_id::text, ''), name, extract_patterns,
		       otp_min_len, otp_max_len, template_body, default_body,
		       coalesce(fallback_action::text, ''), coalesce(brand, '')
		  FROM route_templates
		 WHERE is_active`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		t := &Template{}
		var fb string
		if err := rows.Scan(&t.ID, &t.RouteID, &t.OrgID, &t.Name, &t.Patterns, &t.MinLen, &t.MaxLen,
			&t.Body, &t.DefaultBody, &fb, &t.Brand); err != nil {
			return err
		}
		t.Fallback = otp.Action(fb)
		d.Templates = append(d.Templates, t)
	}
	return rows.Err()
}

func loadSenderIDs(ctx context.Context, q querier, d *Data, _ *crypto.Cipher) error {
	rows, err := q.Query(ctx, `SELECT id::text, org_id::text, coalesce(route_id::text, ''), sender, status::text FROM sender_ids`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		s := &SenderID{}
		if err := rows.Scan(&s.ID, &s.OrgID, &s.RouteID, &s.Sender, &s.Status); err != nil {
			return err
		}
		d.SenderIDs = append(d.SenderIDs, s)
	}
	return rows.Err()
}

func loadSMPPAccounts(ctx context.Context, q querier, d *Data, _ *crypto.Cipher) error {
	rows, err := q.Query(ctx, `
		SELECT id::text, org_id::text, system_id, password_hash, allowed_bind_types::text[],
		       max_binds, coalesce(max_tps, 0), enabled
		  FROM smpp_accounts`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		a := &SMPPAccount{}
		if err := rows.Scan(&a.ID, &a.OrgID, &a.SystemID, &a.PasswordHash, &a.AllowedBindTypes,
			&a.MaxBinds, &a.MaxTPS, &a.Enabled); err != nil {
			return err
		}
		d.SMPPAccounts = append(d.SMPPAccounts, a)
	}
	return rows.Err()
}

func loadIPRules(ctx context.Context, q querier, d *Data, _ *crypto.Cipher) error {
	rows, err := q.Query(ctx, `SELECT id::text, org_id::text, cidr::text, scope::text FROM ip_whitelists`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		r := &IPRule{}
		var cidr string
		if err := rows.Scan(&r.ID, &r.OrgID, &cidr, &r.Scope); err != nil {
			return err
		}
		p, err := netip.ParsePrefix(cidr)
		if err != nil {
			d.Warnings = append(d.Warnings, fmt.Sprintf("ip_whitelists %s: bad cidr %q: %v", r.ID, cidr, err))
			continue
		}
		r.Prefix = p.Masked()
		d.IPRules = append(d.IPRules, r)
	}
	return rows.Err()
}

func loadWebhooks(ctx context.Context, q querier, d *Data, c *crypto.Cipher) error {
	rows, err := q.Query(ctx, `
		SELECT id::text, org_id::text, url, secret_enc, events, max_retries, enabled, failure_count
		  FROM webhooks`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		w := &Webhook{}
		var enc string
		if err := rows.Scan(&w.ID, &w.OrgID, &w.URL, &enc, &w.Events, &w.MaxRetries, &w.Enabled, &w.FailureCount); err != nil {
			return err
		}
		if c == nil {
			w.SecretErr = fmt.Errorf("no APP_ENC_KEY configured")
		} else if sec, err := c.DecryptString(enc); err != nil {
			w.SecretErr = err
		} else {
			w.Secret = sec
		}
		d.Webhooks = append(d.Webhooks, w)
	}
	return rows.Err()
}

func loadBlockedNumbers(ctx context.Context, q querier, d *Data, _ *crypto.Cipher) error {
	rows, err := q.Query(ctx, `SELECT id::text, coalesce(org_id::text, ''), prefix FROM blocked_numbers`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		b := &BlockedNumber{}
		if err := rows.Scan(&b.ID, &b.OrgID, &b.Prefix); err != nil {
			return err
		}
		d.BlockedNumbers = append(d.BlockedNumbers, b)
	}
	return rows.Err()
}

func loadApprovedContent(ctx context.Context, q querier, d *Data, _ *crypto.Cipher) error {
	rows, err := q.Query(ctx, `SELECT id::text, org_id::text, content, status::text FROM approved_content`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		a := &ApprovedContent{}
		if err := rows.Scan(&a.ID, &a.OrgID, &a.Content, &a.Status); err != nil {
			return err
		}
		d.ApprovedContent = append(d.ApprovedContent, a)
	}
	return rows.Err()
}

// loadSwitches reads the single-row global service_switches table. A
// missing row leaves d.Switches nil, which the snapshot treats as all-on
// (DefaultSwitches) — the kill switch must never cause an outage by its
// absence.
func loadSwitches(ctx context.Context, q querier, d *Data, _ *crypto.Cipher) error {
	rows, err := q.Query(ctx, `SELECT all_enabled, http_api_enabled, smpp_enabled, bulk_enabled, updated_at
		FROM service_switches ORDER BY id LIMIT 1`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		sw := &Switches{}
		if err := rows.Scan(&sw.AllEnabled, &sw.HTTPAPIEnabled, &sw.SMPPEnabled, &sw.BulkEnabled, &sw.UpdatedAt); err != nil {
			return err
		}
		d.Switches = sw
	}
	return rows.Err()
}

func loadBlockedKeywords(ctx context.Context, q querier, d *Data, _ *crypto.Cipher) error {
	rows, err := q.Query(ctx, `SELECT id::text, coalesce(org_id::text, ''), pattern FROM blocked_keywords`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		k := &BlockedKeyword{}
		if err := rows.Scan(&k.ID, &k.OrgID, &k.Pattern); err != nil {
			return err
		}
		d.BlockedKeywords = append(d.BlockedKeywords, k)
	}
	return rows.Err()
}

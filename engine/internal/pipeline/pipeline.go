// Package pipeline is the engine's ordered submit flow (CONTRACTS §9) shared
// by the internal HTTP API (channels HTTP / WEB) and the client SMPP server
// (channel SMPP):
//
//  1. org effective state + channel flag      → ACCOUNT_SUSPENDED / SENDING_DISABLED / CHANNEL_DISABLED
//  2. destination normalization                → INVALID_DESTINATION
//  3. blocked numbers / keywords               → DESTINATION_BLOCKED / CONTENT_BLOCKED
//  4. route selection                          → ROUTE_NOT_FOUND
//  5. sender (force_sender_id, sender_ids)     → SENDER_NOT_ALLOWED
//  6. template / OTP rewrite                   → OTP_NOT_FOUND
//  7. encoding + parts of the final text       → MESSAGE_TOO_LONG
//  8. TPS / daily / monthly limits             → RATE_LIMITED / DAILY_LIMIT / MONTHLY_LIMIT
//  9. debit (client + reseller, one script)    → INSUFFICIENT_FUNDS
//  10. CDR (ACCEPTED), Redis msg state, XADD q:dispatch:<route_id>
//
// Any failure after the debit refunds it (and releases the day/month
// counters taken in step 8).
package pipeline

import (
	"context"
	"log/slog"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"smsgw/engine/internal/billing"
	"smsgw/engine/internal/cdr"
	"smsgw/engine/internal/metrics"
	"smsgw/engine/internal/otp"
	"smsgw/engine/internal/phone"
	"smsgw/engine/internal/policy"
	"smsgw/engine/internal/ratelimit"
	"smsgw/engine/internal/routing"
	"smsgw/engine/internal/smpp/coding"
	"smsgw/engine/internal/store"
)

// Snapshotter returns the current configuration snapshot (*store.Store).
type Snapshotter interface {
	Current() *store.Snapshot
}

// Biller is the subset of *billing.Biller the pipeline uses.
type Biller interface {
	Debit(ctx context.Context, txnID string, legs []billing.Leg) (billing.DebitResult, error)
	Refund(ctx context.Context, txnID string, legs []billing.Leg, amounts []int64) (billing.RefundResult, error)
}

// Limiter is the subset of *ratelimit.Limiter the pipeline uses.
type Limiter interface {
	Check(ctx context.Context, r ratelimit.Request) (ratelimit.Counts, error)
	Release(ctx context.Context, r ratelimit.Request, at time.Time) error
}

// CDRSink receives CDR writes (*cdr.Writer).
type CDRSink interface {
	Insert(ctx context.Context, r cdr.Record) error
	Update(ctx context.Context, u cdr.Update) error
}

// Deps are the pipeline's collaborators.
type Deps struct {
	Store   Snapshotter
	Biller  Biller
	Limiter Limiter
	CDR     CDRSink
	Redis   redis.UniversalClient
	// DB (optional) records refunds in the Postgres ledger when the Redis
	// balance is gone (refund.lua NOT_LOADED).
	DB      *pgxpool.Pool
	Metrics *metrics.Engine
	Logger  *slog.Logger

	MsgStateTTL time.Duration    // msg:<id> lifetime; default 72h
	Now         func() time.Time // default time.Now
}

// Pipeline is safe for concurrent use.
type Pipeline struct {
	d   Deps
	log *slog.Logger
}

// New creates a Pipeline.
func New(d Deps) *Pipeline {
	if d.MsgStateTTL <= 0 {
		d.MsgStateTTL = 72 * time.Hour
	}
	if d.Now == nil {
		d.Now = time.Now
	}
	if d.Logger == nil {
		d.Logger = slog.Default()
	}
	if d.Metrics == nil {
		d.Metrics = metrics.NewEngine(metrics.NewRegistry())
	}
	return &Pipeline{d: d, log: d.Logger.With("component", "pipeline")}
}

// Request is one submission.
type Request struct {
	OrgID       string
	Channel     string // store.ChannelHTTP | ChannelWeb | ChannelSMPP
	Source      string
	Destination string
	Text        string
	ClientRef   string
	CampaignID  string
	RouteID     string // forced route (tester); must be assigned to the org
	Test        bool   // tester: SUPER_ADMIN traffic is never billed

	// SMPP only.
	MessageID          string // id already returned / to be returned to the ESME ("" = generate)
	SMPPSystemID       string
	RegisteredDelivery uint8 // client registered_delivery bits (0 = no receipt wanted)
}

// Result is a successful submission (CONTRACTS §5 submit response).
type Result struct {
	MessageID  string    `json:"message_id"`
	Status     string    `json:"status"`
	Parts      int       `json:"parts"`
	Encoding   string    `json:"encoding"`
	CostMicros int64     `json:"cost_micros"`
	RouteID    string    `json:"route_id"`
	SentText   string    `json:"sent_text"`
	CreatedAt  time.Time `json:"-"`
}

// NewMessageID returns a fresh UUIDv7 message id.
func NewMessageID() string {
	id, err := uuid.NewV7()
	if err != nil { // only on a broken random source
		return uuid.NewString()
	}
	return id.String()
}

// Submit runs the full ordered flow. Rejections are *policy.Error.
func (p *Pipeline) Submit(ctx context.Context, req Request) (res *Result, err error) {
	start := time.Now()
	defer func() {
		label := "accepted"
		if err != nil {
			label = string(policy.CodeOf(err))
		}
		p.d.Metrics.SubmitTotal.With(req.Channel, label).Inc()
		p.d.Metrics.SubmitLatency.With(req.Channel).Observe(time.Since(start).Seconds())
		if err == nil {
			p.d.Metrics.PartsAccepted.With(req.Channel).Add(float64(res.Parts))
			p.d.Metrics.TPSIn.Add(1)
		}
	}()
	if err := validateRequest(&req); err != nil {
		return nil, err
	}
	snap := p.d.Store.Current()
	if snap == nil {
		return nil, policy.New(policy.CodeInternal, "configuration not loaded")
	}

	// 1. Org state and channel.
	org := snap.Org(req.OrgID)
	if err := policy.CheckOrg(org, req.Channel); err != nil {
		return nil, err
	}
	var acct *store.SMPPAccount
	if req.Channel == store.ChannelSMPP {
		acct = snap.SMPPAccount(req.SMPPSystemID)
		if acct == nil || acct.OrgID != org.ID {
			return nil, policy.New(policy.CodeUnauthorized, "unknown SMPP account")
		}
		if !acct.Enabled {
			return nil, policy.New(policy.CodeChannelDisabled, "SMPP account is disabled")
		}
	}

	// 2. Destination.
	dest, err := phone.NormalizeMSISDN(req.Destination)
	if err != nil {
		return nil, err
	}

	// 3. Blocklists.
	if err := policy.CheckDestination(snap, org.ID, dest); err != nil {
		return nil, err
	}
	if err := policy.CheckContent(snap, org.ID, req.Text); err != nil {
		return nil, err
	}

	// 4. Route.
	sel, err := routing.SelectRoute(snap, org.ID, dest, req.RouteID)
	if err != nil {
		return nil, err
	}
	route := sel.Route

	// 5. Sender.
	sender, _, err := policy.ResolveSender(snap, org.ID, route, req.Source)
	if err != nil {
		return nil, err
	}
	src, err := phone.ClassifySender(sender)
	if err != nil {
		return nil, err
	}

	// 6. Template.
	finalText := req.Text
	var otpExtracted *bool
	templateID := ""
	if route.TemplateMode {
		tr, tpl, err := ResolveTemplate(snap, route, org.ID, req.Text, src.Normalized)
		if err != nil {
			return nil, err
		}
		if tpl != nil {
			templateID = tpl.ID
		}
		found := tr.OTP != ""
		otpExtracted = &found
		if tr.Action == otp.ActionReject {
			return nil, policy.New(policy.CodeOTPNotFound, "no OTP found in message text")
		}
		finalText = tr.Output
	}

	// 7. Encoding / parts.
	info := coding.Analyze(finalText)
	if info.TooLong() {
		return nil, policy.Errorf(policy.CodeMessageTooLong, "message needs %d parts (max %d)", info.Parts, coding.MaxParts)
	}
	parts := info.Parts

	// 8. Velocity limits.
	rl := ratelimit.Request{OrgID: org.ID, TPS: policy.EffectiveTPS(org, acct), DailyLimit: org.DailyLimit,
		MonthlyLimit: org.MonthlyLimit, Timezone: org.Timezone, N: 1}
	counts, err := p.d.Limiter.Check(ctx, rl)
	if err != nil {
		if policy.CodeOf(err) == policy.CodeInternal {
			return nil, policy.Wrap(policy.CodeInternal, "rate limiter unavailable", err)
		}
		return nil, err
	}
	release := func() {
		if rerr := p.d.Limiter.Release(context.WithoutCancel(ctx), rl, counts.At); rerr != nil {
			p.log.Warn("rate limit release failed", "org_id", org.ID, "err", rerr)
		}
	}

	// 9. Debit.
	msgID := req.MessageID
	if msgID == "" {
		msgID = NewMessageID()
	}
	clientCost, resellerCost := sel.Charges(parts)
	tag, legs := billingLegs(snap, org, sel, clientCost, resellerCost)
	billed := len(legs) > 0 && !(req.Test && org.Role == store.RoleSuperAdmin)
	if billed {
		if _, err := p.d.Biller.Debit(ctx, msgID, toBillingLegs(tag, legs)); err != nil {
			release()
			if policy.CodeOf(err) == policy.CodeInternal {
				return nil, policy.Wrap(policy.CodeInternal, "billing unavailable", err)
			}
			return nil, err
		}
	} else {
		tag, legs = "", nil
	}

	// 10. Persist + enqueue.
	now := p.d.Now().UTC().Truncate(time.Millisecond)
	resellerID := ""
	if r := snap.Reseller(org.ID); r != nil {
		resellerID = r.ID
	}
	clientRef := req.ClientRef
	if req.Channel == store.ChannelSMPP && clientRef == "" {
		clientRef = msgID // the id returned in submit_sm_resp
	}
	rec := cdr.Record{
		ID: msgID, CreatedAt: now, OrgID: org.ID, ResellerID: resellerID, RouteID: route.ID,
		TemplateID: templateID, CampaignID: req.CampaignID, Channel: req.Channel, ClientMsgRef: clientRef,
		SourceAddr: src.Normalized, SourceTON: int(src.TON), SourceNPI: int(src.NPI),
		DestinationAddr: dest, DestTON: int(phone.TONInternational), DestNPI: int(phone.NPIE164),
		CountryISO: phone.CountryCode(dest), OrigText: req.Text, SentText: finalText, OTPExtracted: otpExtracted,
		Encoding: info.Encoding.String(), Parts: parts, Status: cdr.StatusAccepted,
	}
	if sel.Client != nil {
		rate := sel.ClientRate()
		rec.ClientRateMicros = &rate
		rec.ClientCostMicros = &clientCost
		rc := resellerCost
		if org.Role == store.RoleReseller {
			rc = clientCost // a reseller sending itself pays the admin directly
		}
		rec.ResellerCostMicros = &rc
	}
	refund := func(reason string) {
		if !billed {
			return
		}
		RefundLegs(context.WithoutCancel(ctx), p.d.Biller, p.d.DB, p.log, p.d.Metrics, msgID, tag, legs, nil, reason)
	}
	if err := p.d.CDR.Insert(ctx, rec); err != nil {
		refund("cdr_unavailable")
		release()
		return nil, policy.Wrap(policy.CodeInternal, "could not record message", err)
	}

	job := &DispatchJob{
		ID: msgID, CreatedMS: now.UnixMilli(), OrgID: org.ID, Reseller: resellerID, RouteID: route.ID,
		Channel: req.Channel, Source: src.Normalized, SourceTON: src.TON, SourceNPI: src.NPI, Dest: dest,
		Text: finalText, Encoding: info.Encoding.String(), Parts: parts, Tag: tag, Legs: legs,
		ClientRate: sel.ClientRate(), ResellerRate: sel.ResellerRate(),
	}
	if err := p.enqueue(ctx, job, req, clientRef); err != nil {
		refund("enqueue_failed")
		release()
		code := "ENQUEUE_FAILED"
		upd := cdr.Update{ID: msgID, CreatedAt: now, Status: cdr.StatusFailed, ErrorCode: &code}
		if billed {
			t := true
			upd.Refunded = &t
		}
		if uerr := p.d.CDR.Update(context.WithoutCancel(ctx), upd); uerr != nil {
			p.log.Error("cdr update failed", "message_id", msgID, "err", uerr)
		}
		return nil, policy.Wrap(policy.CodeInternal, "could not queue message", err)
	}
	return &Result{
		MessageID: msgID, Status: cdr.StatusAccepted, Parts: parts, Encoding: info.Encoding.String(),
		CostMicros: clientCostOrZero(billed, clientCost), RouteID: route.ID, SentText: finalText, CreatedAt: now,
	}, nil
}

func clientCostOrZero(billed bool, c int64) int64 {
	if !billed {
		return 0
	}
	return c
}

func (p *Pipeline) enqueue(ctx context.Context, job *DispatchJob, req Request, clientRef string) error {
	payload, err := EncodeJob(job)
	if err != nil {
		return err
	}
	rd := "1"
	if req.Channel == store.ChannelSMPP {
		rd = strconv.Itoa(int(req.RegisteredDelivery & 0x03))
	}
	key := MsgKey(job.ID)
	_, err = p.d.Redis.TxPipelined(ctx, func(pl redis.Pipeliner) error {
		pl.HSet(ctx, key,
			FOrgID, job.OrgID, FResellerID, job.Reseller, FChannel, job.Channel,
			FParts, job.Parts, FDelivered, 0, FFailed, 0, FCreatedAtMS, job.CreatedMS,
			FClientRef, clientRef, FSMPPSystemID, req.SMPPSystemID,
			FSource, job.Source, FDest, job.Dest, FRegDelivery, rd, FText20, firstRunes(req.Text, 20),
			FRouteID, job.RouteID)
		pl.Expire(ctx, key, p.d.MsgStateTTL)
		pl.XAdd(ctx, &redis.XAddArgs{Stream: DispatchStream(job.RouteID), Values: []any{JobField, payload}})
		return nil
	})
	return err
}

func firstRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}

func validateRequest(r *Request) error {
	switch r.Channel {
	case store.ChannelHTTP, store.ChannelWeb, store.ChannelSMPP:
	default:
		return policy.Errorf(policy.CodeInvalidRequest, "invalid channel %q", r.Channel)
	}
	if _, err := uuid.Parse(r.OrgID); err != nil {
		return policy.New(policy.CodeInvalidRequest, "org_id must be a uuid")
	}
	if r.RouteID != "" {
		if _, err := uuid.Parse(r.RouteID); err != nil {
			return policy.New(policy.CodeInvalidRequest, "route_id must be a uuid")
		}
	}
	if r.CampaignID != "" {
		if _, err := uuid.Parse(r.CampaignID); err != nil {
			return policy.New(policy.CodeInvalidRequest, "campaign_id must be a uuid")
		}
	}
	if r.MessageID != "" {
		if _, err := uuid.Parse(r.MessageID); err != nil {
			return policy.New(policy.CodeInvalidRequest, "message id must be a uuid")
		}
	}
	if strings.TrimSpace(r.Destination) == "" {
		return policy.New(policy.CodeInvalidDestination, "destination is required")
	}
	if r.Text == "" {
		return policy.New(policy.CodeInvalidRequest, "text is required")
	}
	if !utf8.ValidString(r.Text) {
		return policy.New(policy.CodeInvalidRequest, "text must be valid UTF-8")
	}
	if len(r.ClientRef) > 255 {
		return policy.New(policy.CodeInvalidRequest, "client_ref is too long (max 255)")
	}
	if r.Channel == store.ChannelSMPP && r.SMPPSystemID == "" {
		return policy.New(policy.CodeInvalidRequest, "SMPP submission without system_id")
	}
	return nil
}

// billingLegs returns the balance tag and debit legs (client first,
// reseller second) for a selection. SUPER_ADMIN → no legs.
func billingLegs(snap *store.Snapshot, org *store.Org, sel *routing.Selection, clientCost, resellerCost int64) (string, []Leg) {
	tag, ok := snap.BalanceTag(org.ID)
	if !ok || sel.Client == nil {
		return "", nil
	}
	switch org.Role {
	case store.RoleClient:
		return tag, []Leg{{OrgID: org.ID, Amount: clientCost}, {OrgID: tag, Amount: resellerCost}}
	case store.RoleReseller:
		return tag, []Leg{{OrgID: org.ID, Amount: clientCost}}
	}
	return "", nil
}

func toBillingLegs(tag string, legs []Leg) []billing.Leg {
	out := make([]billing.Leg, len(legs))
	for i, l := range legs {
		out[i] = billing.Leg{OrgID: l.OrgID, Tag: tag, Amount: l.Amount}
	}
	return out
}

// RefundLegs refunds a message debit (amounts nil = everything not yet
// refunded; otherwise one cap per leg). When the Redis balance can no
// longer be loaded the refund is recorded in the Postgres ledger (db may be
// nil, in which case it is only logged). Errors are logged, never returned:
// refunds are best effort and idempotent per message id.
func RefundLegs(ctx context.Context, b Biller, db *pgxpool.Pool, log *slog.Logger, m *metrics.Engine,
	msgID, tag string, legs []Leg, amounts []int64, reason string) {
	if len(legs) == 0 || tag == "" {
		return
	}
	res, err := b.Refund(ctx, msgID, toBillingLegs(tag, legs), amounts)
	if err != nil {
		log.Error("refund failed", "message_id", msgID, "reason", reason, "err", err)
		return
	}
	if m != nil {
		m.Refunds.With(reason).Inc()
	}
	switch res.Status {
	case billing.StatusOK, billing.StatusNothingToRefund:
		return
	case billing.StatusNoTxn:
		log.Warn("refund: debit record expired; nothing refunded", "message_id", msgID, "reason", reason)
		return
	case billing.StatusNotLoaded:
		if db == nil {
			log.Error("refund: balance not loaded and no database to record it", "message_id", msgID)
			return
		}
		for i, l := range legs {
			amt := l.Amount
			if amounts != nil {
				amt = min(amounts[i], l.Amount)
			}
			if amt <= 0 {
				continue
			}
			if err := ledgerRefund(ctx, db, l.OrgID, amt, msgID); err != nil {
				log.Error("ledger refund failed", "message_id", msgID, "org_id", l.OrgID, "err", err)
			}
		}
	}
}

// ledgerRefund records a refund directly in Postgres (balance not in Redis).
func ledgerRefund(ctx context.Context, db *pgxpool.Pool, orgID string, amount int64, msgID string) error {
	tx, err := db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	tag, err := tx.Exec(ctx, `
		INSERT INTO balance_transactions (org_id, type, amount_micros, idempotency_key, reference, note, applied_at)
		VALUES ($1, 'REFUND', $2, $3, $4, 'engine refund (balance not loaded)', now())
		ON CONFLICT (idempotency_key) DO NOTHING`, orgID, amount, "refund:"+msgID+":"+orgID, msgID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 1 {
		if _, err := tx.Exec(ctx, `UPDATE accounts_balance SET balance_micros = balance_micros + $2 WHERE org_id = $1`, orgID, amount); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// ResolveTemplate applies §9 step 6 for (route, client org): the effective
// template (client override, else route default) with the brand chain
// template → client → reseller. A template with invalid patterns is a
// configuration error (INTERNAL).
func ResolveTemplate(snap *store.Snapshot, route *store.Route, orgID, text, sender string) (otp.Result, *store.Template, error) {
	tpl := snap.EffectiveTemplate(route.ID, orgID)
	if tpl == nil {
		r, err := otp.Resolve(nil, route.TemplateFallback, text, otp.Vars{})
		return r, nil, err
	}
	if tpl.PatternErr != nil {
		return otp.Result{}, tpl, policy.Wrap(policy.CodeInternal, "route template is misconfigured", tpl.PatternErr)
	}
	r, err := otp.Resolve(&tpl.Template, route.TemplateFallback, text, otp.Vars{Brand: snap.Brand(orgID), Sender: sender})
	if err != nil {
		return otp.Result{}, tpl, policy.Wrap(policy.CodeInternal, "route template is misconfigured", err)
	}
	return r, tpl, nil
}

// --- template preview (CONTRACTS §5) -----------------------------------------

// InlineTemplate is the "template" object of a preview request.
type InlineTemplate struct {
	ExtractPatterns []string `json:"extract_patterns"`
	OTPMinLen       int      `json:"otp_min_len"`
	OTPMaxLen       int      `json:"otp_max_len"`
	TemplateBody    string   `json:"template_body"`
	DefaultBody     *string  `json:"default_body"`
	FallbackAction  *string  `json:"fallback_action"`
	Brand           *string  `json:"brand"`
}

// PreviewRequest is POST /internal/v1/template/preview.
type PreviewRequest struct {
	Text     string          `json:"text"`
	RouteID  string          `json:"route_id"`
	OrgID    string          `json:"org_id"`
	Template *InlineTemplate `json:"template"`
}

// PreviewResult is the preview response.
type PreviewResult struct {
	OTP            *string `json:"otp"`
	MatchedPattern *string `json:"matched_pattern"`
	Action         string  `json:"action"`
	Output         *string `json:"output"`
	Encoding       string  `json:"encoding"`
	Parts          int     `json:"parts"`
	TemplateID     *string `json:"template_id"`
}

// Preview resolves a template without sending anything.
func (p *Pipeline) Preview(_ context.Context, req PreviewRequest) (*PreviewResult, error) {
	if req.Text == "" {
		return nil, policy.New(policy.CodeInvalidRequest, "text is required")
	}
	snap := p.d.Store.Current()
	if snap == nil {
		return nil, policy.New(policy.CodeInternal, "configuration not loaded")
	}
	var route *store.Route
	if req.RouteID != "" {
		if route = snap.Route(req.RouteID); route == nil {
			return nil, policy.New(policy.CodeNotFound, "route not found")
		}
	}
	if req.OrgID != "" && snap.Org(req.OrgID) == nil {
		return nil, policy.New(policy.CodeNotFound, "organization not found")
	}
	var (
		r     otp.Result
		tplID *string
		err   error
	)
	switch {
	case req.Template != nil:
		t := req.Template
		if strings.TrimSpace(t.TemplateBody) == "" || !strings.Contains(t.TemplateBody, "{otp}") {
			return nil, policy.New(policy.CodeInvalidRequest, "template_body must contain {otp}")
		}
		patterns := t.ExtractPatterns
		if len(patterns) == 0 {
			patterns = otp.DefaultPatterns
		}
		if err := otp.ValidatePatterns(patterns); err != nil {
			return nil, policy.Errorf(policy.CodeInvalidRequest, "%v", err)
		}
		minLen, maxLen := t.OTPMinLen, t.OTPMaxLen
		if minLen <= 0 {
			minLen = otp.DefaultMinLen
		}
		if maxLen <= 0 {
			maxLen = otp.DefaultMaxLen
		}
		if maxLen < minLen {
			return nil, policy.New(policy.CodeInvalidRequest, "otp_max_len must be >= otp_min_len")
		}
		tpl := &otp.Template{Patterns: patterns, MinLen: minLen, MaxLen: maxLen, Body: t.TemplateBody, DefaultBody: t.DefaultBody}
		if t.FallbackAction != nil && *t.FallbackAction != "" {
			a := otp.Action(*t.FallbackAction)
			if !otp.ValidFallback(a) {
				return nil, policy.Errorf(policy.CodeInvalidRequest, "invalid fallback_action %q", *t.FallbackAction)
			}
			tpl.Fallback = a
		}
		if t.Brand != nil {
			tpl.Brand = *t.Brand
		}
		routeFallback := otp.ActionSendRaw
		if route != nil {
			routeFallback = route.TemplateFallback
		}
		brand := ""
		if req.OrgID != "" {
			brand = snap.Brand(req.OrgID)
		}
		r, err = otp.Resolve(tpl, routeFallback, req.Text, otp.Vars{Brand: brand})
		if err != nil {
			return nil, policy.Errorf(policy.CodeInvalidRequest, "%v", err)
		}
	case route != nil:
		var tpl *store.Template
		r, tpl, err = ResolveTemplate(snap, route, req.OrgID, req.Text, "")
		if err != nil {
			return nil, err
		}
		if tpl != nil {
			id := tpl.ID
			tplID = &id
		}
	default:
		return nil, policy.New(policy.CodeInvalidRequest, "either template or route_id is required")
	}
	out := &PreviewResult{Action: string(r.Action), TemplateID: tplID}
	if r.OTP != "" {
		v := r.OTP
		out.OTP = &v
	}
	if r.MatchedPattern != "" {
		v := r.MatchedPattern
		out.MatchedPattern = &v
	}
	measured := req.Text
	if r.Action != otp.ActionReject {
		v := r.Output
		out.Output = &v
		measured = r.Output
	}
	info := coding.Analyze(measured)
	out.Encoding, out.Parts = info.Encoding.String(), info.Parts
	return out, nil
}

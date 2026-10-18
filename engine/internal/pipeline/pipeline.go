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
	// RefundUnloaded is the locked ledger path for refund.lua NOT_LOADED.
	RefundUnloaded(ctx context.Context, txnID string, legs []billing.Leg, amounts []int64) (billing.RefundResult, error)
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
	// DB is kept for callers that pass it; ledger refunds go through
	// Biller.RefundUnloaded.
	DB      *pgxpool.Pool
	Metrics *metrics.Engine
	Logger  *slog.Logger
	// Refunder (optional) applies and retries refunds; default: one built
	// from Biller, Redis and CDR (its retry loop is then not running — the
	// app runs the shared Refunder).
	Refunder *Refunder

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
	if d.Refunder == nil {
		d.Refunder = NewRefunder(d.Biller, d.Redis, d.CDR, RefunderOptions{Logger: d.Logger, Metrics: d.Metrics})
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

	// 7. Encoding / parts: the number of segments actually sent (Split
	// never breaks an escape or surrogate pair, so it can exceed the
	// ceil(units/153) arithmetic) — billing, MaxParts, the CDR and the
	// dispatcher all use this count.
	info, err := MeasureText(finalText)
	if err != nil {
		return nil, err
	}
	if info.TooLong() {
		return nil, policy.Errorf(policy.CodeMessageTooLong, "message needs %d parts (max %d)", info.Parts, coding.MaxParts)
	}
	parts := info.Parts

	msgID := req.MessageID
	if msgID == "" {
		msgID = NewMessageID()
	}

	// An api retry (HTTP/WEB message_id) of a message an earlier attempt
	// already queued: answer it again before the limiters, which would count
	// it twice or refuse it. Races between concurrent attempts are settled by
	// the debit below (DUPLICATE → replay).
	if req.Channel != store.ChannelSMPP && req.MessageID != "" && p.alreadyAccepted(ctx, msgID) {
		clientCost, resellerCost := sel.Charges(parts)
		_, legs := billingLegs(snap, org, sel, clientCost, resellerCost)
		billed := len(legs) > 0 && !(req.Test && org.Role == store.RoleSuperAdmin)
		p.log.Info("idempotent replay of an accepted message", "message_id", msgID)
		return &Result{
			MessageID: msgID, Status: cdr.StatusAccepted, Parts: parts, Encoding: info.Encoding.String(),
			CostMicros: clientCostOrZero(billed, clientCost), RouteID: route.ID, SentText: finalText, CreatedAt: p.d.Now().UTC(),
		}, nil
	}

	// 8. Velocity limits.
	rl := ratelimit.Request{OrgID: org.ID, TPS: policy.EffectiveTPS(org, acct), DailyLimit: org.DailyLimit,
		MonthlyLimit: org.MonthlyLimit, Timezone: org.Timezone, N: 1, Token: msgID}
	counts, err := p.d.Limiter.Check(ctx, rl)
	if err != nil {
		if policy.CodeOf(err) == policy.CodeInternal {
			return nil, policy.Wrap(policy.CodeInternal, "rate limiter unavailable", err)
		}
		return nil, err
	}
	release := func() {
		if counts.Replayed {
			return // this attempt counted nothing (the token's first check did)
		}
		if rerr := p.d.Limiter.Release(context.WithoutCancel(ctx), rl, counts.At); rerr != nil {
			p.log.Warn("rate limit release failed", "org_id", org.ID, "err", rerr)
		}
	}

	// 9. Debit.
	clientCost, resellerCost := sel.Charges(parts)
	tag, legs := billingLegs(snap, org, sel, clientCost, resellerCost)
	billed := len(legs) > 0 && !(req.Test && org.Role == store.RoleSuperAdmin)
	if billed {
		dr, err := p.d.Biller.Debit(ctx, msgID, toBillingLegs(tag, legs))
		if err != nil {
			release()
			if policy.CodeOf(err) == policy.CodeInternal {
				// The script may have run even though we got no reply (read
				// timeout, connection reset): undo it. refund.lua is
				// idempotent and answers NO_TXN when nothing was debited.
				// A caller-chosen id (api retry) may belong to a message that
				// an earlier attempt already queued: never refund that one.
				if !p.alreadyAccepted(ctx, msgID) {
					p.d.Refunder.Refund(context.WithoutCancel(ctx), msgID, tag, legs, nil, "debit_error", nil)
				}
				return nil, policy.Wrap(policy.CodeInternal, "billing unavailable", err)
			}
			return nil, err
		}
		if dr.Status == billing.StatusDuplicate {
			// Same message id debited before: an api retry of a submit whose
			// outcome it never saw (timeout / 5xx). Nothing is charged, stored
			// or queued again.
			release()
			return p.replay(ctx, msgID, tag, &Result{
				MessageID: msgID, Status: cdr.StatusAccepted, Parts: parts, Encoding: info.Encoding.String(),
				CostMicros: clientCost, RouteID: route.ID, SentText: finalText, CreatedAt: p.d.Now().UTC(),
			})
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
	// refund returns whether the money is back now; a refund that fails
	// transiently is retried later and then applies onApplied to the CDR.
	refund := func(reason string, onApplied *cdr.Update) bool {
		if !billed {
			return false
		}
		return p.d.Refunder.Refund(context.WithoutCancel(ctx), msgID, tag, legs, nil, reason, onApplied) == RefundApplied
	}
	if err := p.d.CDR.Insert(ctx, rec); err != nil {
		refund("cdr_unavailable", nil)
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
		// MULTI/EXEC may have executed even though the reply was lost: the
		// msg state and the stream entry are written atomically, so the
		// state's presence proves the entry landed.
		if landed, verr := p.enqueued(ctx, msgID); verr == nil && landed {
			p.log.Warn("enqueue reported an error but the message was queued", "message_id", msgID, "err", err)
		} else {
			// Not queued (or unknown): make sure a late entry is never
			// dispatched (the dispatcher skips messages marked done), then
			// refund.
			p.markUndispatchable(ctx, msgID)
			code := "ENQUEUE_FAILED"
			t := true
			upd := cdr.Update{ID: msgID, CreatedAt: now, Status: cdr.StatusFailed, ErrorCode: &code}
			if refund("enqueue_failed", &cdr.Update{ID: msgID, CreatedAt: now, Refunded: &t}) {
				upd.Refunded = &t
			}
			release()
			if uerr := p.d.CDR.Update(context.WithoutCancel(ctx), upd); uerr != nil {
				p.log.Error("cdr update failed", "message_id", msgID, "err", uerr)
			}
			return nil, policy.Wrap(policy.CodeInternal, "could not queue message", err)
		}
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

// alreadyAccepted reports whether a message with this id was queued: its
// msg:<id> state carries created_at_ms, which only the enqueue transaction
// writes (a failed enqueue leaves just done/status, see
// markUndispatchable). Errors count as "no": callers then behave as before.
func (p *Pipeline) alreadyAccepted(ctx context.Context, msgID string) bool {
	if p.d.Redis == nil {
		return false
	}
	ok, err := p.d.Redis.HExists(context.WithoutCancel(ctx), MsgKey(msgID), FCreatedAtMS).Result()
	return err == nil && ok
}

// replay answers a submit whose message id was already debited (debit.lua
// DUPLICATE): the api retried a submit it got no answer for. If the earlier
// attempt queued the message, its acceptance is returned again (idempotent).
// If it failed and was refunded, the retry fails too (INTERNAL, as the first
// answer would have); if it is still between debit and enqueue, CONFLICT
// (retry later with the same id).
func (p *Pipeline) replay(ctx context.Context, msgID, tag string, res *Result) (*Result, error) {
	if p.alreadyAccepted(ctx, msgID) {
		p.log.Info("idempotent replay of an accepted message", "message_id", msgID)
		return res, nil
	}
	state := ""
	if p.d.Redis != nil {
		state, _ = p.d.Redis.HGet(context.WithoutCancel(ctx), billing.TxnKey(tag, msgID), "state").Result()
	}
	if state == "REFUNDED" || state == "PARTIALLY_REFUNDED" {
		return nil, policy.New(policy.CodeInternal, "an earlier submit with this message_id failed and was refunded; submit with a new message_id")
	}
	return nil, policy.New(policy.CodeConflict, "a submit with this message_id is still being processed; retry later with the same message_id")
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

// enqueued reports whether the msg state of msgID exists (enqueue's
// MULTI/EXEC ran).
func (p *Pipeline) enqueued(ctx context.Context, msgID string) (bool, error) {
	cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
	defer cancel()
	return p.d.Redis.HExists(cctx, MsgKey(msgID), FCreatedAtMS).Result()
}

// markUndispatchable flags msgID as finished so a stream entry that landed
// despite the reported error is skipped by the dispatcher.
func (p *Pipeline) markUndispatchable(ctx context.Context, msgID string) {
	cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
	defer cancel()
	key := MsgKey(msgID)
	if _, err := p.d.Redis.TxPipelined(cctx, func(pl redis.Pipeliner) error {
		pl.HSet(cctx, key, FDone, 1, FStatus, cdr.StatusFailed)
		pl.Expire(cctx, key, p.d.MsgStateTTL)
		return nil
	}); err != nil {
		p.log.Error("could not mark message undispatchable", "message_id", msgID, "err", err)
	}
}

// MeasureText returns the encoding and the exact number of segments
// (len(coding.Split)) of text, as the dispatcher will send it.
func MeasureText(text string) (coding.Info, error) {
	info := coding.Analyze(text)
	segs, err := coding.Split(text, info.Encoding)
	if err != nil {
		return info, policy.Wrap(policy.CodeInternal, "cannot segment text", err)
	}
	info.Parts = len(segs)
	return info, nil
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
	// U+0000 is valid UTF-8 but PostgreSQL text cannot store it: the
	// message would be charged and sent with its CDR silently dropped.
	if strings.IndexByte(r.Text, 0) >= 0 {
		return policy.New(policy.CodeInvalidRequest, "text must not contain NUL (U+0000) characters")
	}
	if strings.IndexByte(r.Source, 0) >= 0 || strings.IndexByte(r.ClientRef, 0) >= 0 || !utf8.ValidString(r.ClientRef) || !utf8.ValidString(r.Source) {
		return policy.New(policy.CodeInvalidRequest, "source and client_ref must be valid UTF-8 without NUL characters")
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
	info, err := MeasureText(measured)
	if err != nil {
		return nil, err
	}
	out.Encoding, out.Parts = info.Encoding.String(), info.Parts
	return out, nil
}

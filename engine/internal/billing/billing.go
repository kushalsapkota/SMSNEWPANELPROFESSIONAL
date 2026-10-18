// Package billing is the engine's typed client for the canonical Redis
// balance scripts (redis/lua, embedded byte-for-byte in ./lua) plus
// hydration from and write-back to Postgres accounts_balance.
//
// Lifecycle (README "Balance lifecycle"):
//
//   - Debit/Refund run debit.lua/refund.lua. When a balance hash is missing
//     (NOT_LOADED) the Biller hydrates every missing leg from accounts_balance
//     via load.lua and retries exactly once.
//   - Credit runs credit.lua; it never hydrates (on NOT_LOADED the api adds
//     the delta to accounts_balance and hydration picks it up).
//   - Every successful mutation adds "<tag>|<org>" to a Redis dirty set; the
//     Syncer drains it and writes balances back to accounts_balance.
//
// All methods are safe for concurrent use.
package billing

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"smsgw/engine/internal/policy"
)

var (
	//go:embed lua/debit.lua
	debitSrc string
	//go:embed lua/refund.lua
	refundSrc string
	//go:embed lua/credit.lua
	creditSrc string
	//go:embed lua/load.lua
	loadSrc string
)

// setLimitSrc updates the overdraft limit of a loaded balance (credit limit /
// billing mode changes). Engine-internal; not one of the canonical scripts.
const setLimitSrc = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
if not string.match(ARGV[1] or '', '^%d+$') then return redis.error_reply('limit must be a non-negative integer') end
redis.call('HSET', KEYS[1], 'limit', string.format('%d', tonumber(ARGV[1])))
return 1`

var (
	debitScript    = redis.NewScript(debitSrc)
	refundScript   = redis.NewScript(refundSrc)
	creditScript   = redis.NewScript(creditSrc)
	loadScript     = redis.NewScript(loadSrc)
	setLimitScript = redis.NewScript(setLimitSrc)
)

// Script statuses returned by the Lua scripts.
const (
	StatusOK              = "OK"
	StatusDuplicate       = "DUPLICATE"
	StatusNotLoaded       = "NOT_LOADED"
	StatusInsufficient    = "INSUFFICIENT_FUNDS"
	StatusAlreadyLoaded   = "ALREADY_LOADED"
	StatusNothingToRefund = "NOTHING_TO_REFUND"
	StatusNoTxn           = "NO_TXN"
	StatusKeyMismatch     = "KEY_MISMATCH"
	StatusBadArgs         = "BAD_ARGS"
)

var (
	// ErrNoAccount means the org has no accounts_balance row.
	ErrNoAccount = errors.New("billing: no accounts_balance row for org")
	// ErrTagMismatch means a caller passed a tag that is not the org's
	// tenant tag (would create a key in the wrong cluster slot).
	ErrTagMismatch = errors.New("billing: hash tag does not match org hierarchy")
	// ErrNotBillable means a SUPER_ADMIN org was passed (never billed).
	ErrNotBillable = errors.New("billing: SUPER_ADMIN is never billed")
)

// Leg is one balance touched by a debit: the org, its tenant hash tag
// (TagFor) and the amount in micros (>= 0). All legs of one debit must share
// the same tag. Order matters: client first, reseller second (CONTRACTS §8),
// and refunds must use the same order.
type Leg struct {
	OrgID  string
	Tag    string
	Amount int64
}

// Options tune a Biller.
type Options struct {
	TxnTTL        time.Duration // debit record lifetime (refund window); default 72h
	CreditIdemTTL time.Duration // top-up idempotency marker lifetime; default 30 days
	DirtyKey      string        // default DefaultDirtyKey
	Logger        *slog.Logger
}

// Biller runs balance operations. Construct with New.
type Biller struct {
	rdb      redis.UniversalClient
	pool     *pgxpool.Pool
	txnTTL   int64
	idemTTL  int64
	dirtyKey string
	log      *slog.Logger
}

// New creates a Biller. pool must connect as a role that can read and
// update accounts_balance and read organizations (sms_engine).
func New(rdb redis.UniversalClient, pool *pgxpool.Pool, o Options) *Biller {
	if o.TxnTTL <= 0 {
		o.TxnTTL = 72 * time.Hour
	}
	if o.CreditIdemTTL <= 0 {
		o.CreditIdemTTL = 30 * 24 * time.Hour
	}
	if o.DirtyKey == "" {
		o.DirtyKey = DefaultDirtyKey
	}
	if o.Logger == nil {
		o.Logger = slog.Default()
	}
	return &Biller{
		rdb:      rdb,
		pool:     pool,
		txnTTL:   int64(o.TxnTTL / time.Second),
		idemTTL:  int64(o.CreditIdemTTL / time.Second),
		dirtyKey: o.DirtyKey,
		log:      o.Logger.With("component", "billing"),
	}
}

// DebitResult is the outcome of a successful (OK or DUPLICATE) debit.
type DebitResult struct {
	Status   string  // StatusOK or StatusDuplicate
	Balances []int64 // new balances aligned with legs
}

// InsufficientFundsError is returned (wrapped in a *policy.Error with code
// INSUFFICIENT_FUNDS) when a leg would drop below -limit. Nothing is debited.
type InsufficientFundsError struct {
	Leg   int // index into legs
	OrgID string
}

func (e *InsufficientFundsError) Error() string {
	return fmt.Sprintf("billing: insufficient funds on leg %d (org %s)", e.Leg, e.OrgID)
}

func validateLegs(legs []Leg, needAmounts bool) (string, error) {
	if len(legs) == 0 {
		return "", errors.New("billing: at least one leg required")
	}
	tag := legs[0].Tag
	seen := make(map[string]bool, len(legs))
	for i, l := range legs {
		if l.OrgID == "" || l.Tag == "" {
			return "", fmt.Errorf("billing: leg %d: org id and tag required", i)
		}
		if l.Tag != tag {
			return "", fmt.Errorf("billing: leg %d: all legs must share tag %q (got %q)", i, tag, l.Tag)
		}
		if seen[l.OrgID] {
			return "", fmt.Errorf("billing: leg %d: duplicate org %s", i, l.OrgID)
		}
		seen[l.OrgID] = true
		if needAmounts && l.Amount < 0 {
			return "", fmt.Errorf("billing: leg %d: negative amount", i)
		}
	}
	return tag, nil
}

// Debit atomically debits every leg (or none) under transaction id txnID
// (the message id). A retry with the same txnID returns DUPLICATE and charges
// nothing. Missing balances are hydrated from Postgres and the debit is
// retried once. Insufficient funds returns a *policy.Error
// (INSUFFICIENT_FUNDS) wrapping *InsufficientFundsError.
func (b *Biller) Debit(ctx context.Context, txnID string, legs []Leg) (DebitResult, error) {
	tag, err := validateLegs(legs, true)
	if err != nil {
		return DebitResult{}, err
	}
	if txnID == "" {
		return DebitResult{}, errors.New("billing: txn id required")
	}
	keys := make([]string, 0, len(legs)+1)
	keys = append(keys, TxnKey(tag, txnID))
	args := make([]any, 0, len(legs)+1)
	args = append(args, b.txnTTL)
	for _, l := range legs {
		keys = append(keys, BalanceKey(l.Tag, l.OrgID))
		args = append(args, l.Amount)
	}
	for attempt := 0; ; attempt++ {
		res, err := runScript(ctx, b.rdb, debitScript, keys, args)
		if err != nil {
			return DebitResult{}, err
		}
		switch res.status {
		case StatusOK, StatusDuplicate:
			bals, err := res.ints(len(legs))
			if err != nil {
				return DebitResult{}, err
			}
			if res.status == StatusOK {
				b.markDirty(ctx, legs)
			}
			return DebitResult{Status: res.status, Balances: bals}, nil
		case StatusNotLoaded:
			if attempt > 0 {
				return DebitResult{}, fmt.Errorf("billing: balance still not loaded after hydration (leg %s)", res.arg(0))
			}
			if err := b.hydrateMissing(ctx, legs); err != nil {
				return DebitResult{}, err
			}
		case StatusInsufficient:
			i, _ := strconv.Atoi(res.arg(0))
			ife := &InsufficientFundsError{Leg: i - 1}
			if i >= 1 && i <= len(legs) {
				ife.OrgID = legs[i-1].OrgID
			}
			return DebitResult{}, policy.Wrap(policy.CodeInsufficientFunds, "insufficient balance", ife)
		default:
			return DebitResult{}, res.err("debit")
		}
	}
}

// RefundResult is the outcome of Refund.
type RefundResult struct {
	// Status: StatusOK, StatusNothingToRefund, StatusNoTxn (unknown or
	// expired txn) or StatusNotLoaded (balance still missing after a
	// hydration retry: record the refund in the ledger instead).
	Status   string
	Refunded []int64 // per leg, only for StatusOK
}

// Refund returns money debited under txnID. legs must be the same orgs/tag
// in the same order as the debit (Amount is ignored). amounts nil refunds
// everything not yet refunded; otherwise one cap per leg. Refunds are capped
// at what was debited and never applied twice.
func (b *Biller) Refund(ctx context.Context, txnID string, legs []Leg, amounts []int64) (RefundResult, error) {
	tag, err := validateLegs(legs, false)
	if err != nil {
		return RefundResult{}, err
	}
	if amounts != nil && len(amounts) != len(legs) {
		return RefundResult{}, fmt.Errorf("billing: %d amounts for %d legs", len(amounts), len(legs))
	}
	keys := make([]string, 0, len(legs)+1)
	keys = append(keys, TxnKey(tag, txnID))
	for _, l := range legs {
		keys = append(keys, BalanceKey(l.Tag, l.OrgID))
	}
	args := make([]any, 0, len(amounts))
	for i, a := range amounts {
		if a < 0 {
			return RefundResult{}, fmt.Errorf("billing: amount %d negative", i)
		}
		args = append(args, a)
	}
	for attempt := 0; ; attempt++ {
		res, err := runScript(ctx, b.rdb, refundScript, keys, args)
		if err != nil {
			return RefundResult{}, err
		}
		switch res.status {
		case StatusOK:
			refunded, err := res.ints(len(legs))
			if err != nil {
				return RefundResult{}, err
			}
			b.markDirty(ctx, legs)
			return RefundResult{Status: StatusOK, Refunded: refunded}, nil
		case StatusNothingToRefund, StatusNoTxn:
			return RefundResult{Status: res.status}, nil
		case StatusNotLoaded:
			if attempt > 0 {
				return RefundResult{Status: StatusNotLoaded}, nil
			}
			if err := b.hydrateMissing(ctx, legs); err != nil {
				return RefundResult{}, err
			}
		default:
			return RefundResult{}, res.err("refund")
		}
	}
}

// RefundUnloaded refunds txnID after refund.lua reported NOT_LOADED (a leg's
// balance hash is missing even after hydration, e.g. evicted again). It
// follows the ledger locking protocol (CONTRACTS-CHANGES engine-core #3):
//
//  1. every leg's accounts_balance row is locked FOR UPDATE, in leg order —
//     hydration (Load) locks the same row, so no leg can be loaded from a
//     pre-refund value while we work;
//  2. refund.lua is retried (without hydrating) under the locks: a
//     concurrent hydration may have completed in the meantime;
//  3. if a leg is still missing, the refundable remainder of every leg is
//     read from the txn record (debited minus already refunded, capped by
//     amounts): loaded legs are credited in Redis (credit.lua, idempotent),
//     missing ones in Postgres (REFUND ledger row + balance_micros);
//  4. the txn record's refunded counters are advanced so the same money is
//     never refunded twice.
//
// The ledger / credit idempotency key is refund:<txn>:<org> (plus the amount
// already refunded before, when non-zero), so a retry after a partial
// failure never applies twice.
func (b *Biller) RefundUnloaded(ctx context.Context, txnID string, legs []Leg, amounts []int64) (RefundResult, error) {
	tag, err := validateLegs(legs, false)
	if err != nil {
		return RefundResult{}, err
	}
	if amounts != nil && len(amounts) != len(legs) {
		return RefundResult{}, fmt.Errorf("billing: %d amounts for %d legs", len(amounts), len(legs))
	}
	if b.pool == nil {
		return RefundResult{}, errors.New("billing: no database for a ledger refund")
	}
	tx, err := b.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return RefundResult{}, fmt.Errorf("billing: ledger refund begin: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after commit
	for _, l := range legs {
		var one int
		err := tx.QueryRow(ctx, `SELECT 1 FROM accounts_balance WHERE org_id = $1 FOR UPDATE`, l.OrgID).Scan(&one)
		if errors.Is(err, pgx.ErrNoRows) {
			return RefundResult{}, fmt.Errorf("%w %s", ErrNoAccount, l.OrgID)
		}
		if err != nil {
			return RefundResult{}, fmt.Errorf("billing: ledger refund lock %s: %w", l.OrgID, err)
		}
	}

	keys := make([]string, 0, len(legs)+1)
	keys = append(keys, TxnKey(tag, txnID))
	for _, l := range legs {
		keys = append(keys, BalanceKey(l.Tag, l.OrgID))
	}
	args := make([]any, 0, len(amounts))
	for _, a := range amounts {
		if a < 0 {
			return RefundResult{}, errors.New("billing: negative refund amount")
		}
		args = append(args, a)
	}
	res, err := runScript(ctx, b.rdb, refundScript, keys, args)
	if err != nil {
		return RefundResult{}, err
	}
	switch res.status {
	case StatusOK:
		refunded, err := res.ints(len(legs))
		if err != nil {
			return RefundResult{}, err
		}
		b.markDirty(ctx, legs)
		_ = tx.Commit(ctx)
		return RefundResult{Status: StatusOK, Refunded: refunded}, nil
	case StatusNothingToRefund, StatusNoTxn:
		_ = tx.Commit(ctx)
		return RefundResult{Status: res.status}, nil
	case StatusNotLoaded:
	default:
		return RefundResult{}, res.err("refund")
	}

	// Still not loaded: compute the remainder per leg from the txn record.
	fields := make([]string, 0, 3*len(legs)+1)
	fields = append(fields, "n")
	for i := range legs {
		n := strconv.Itoa(i + 1)
		fields = append(fields, "k"+n, "a"+n, "r"+n)
	}
	vals, err := b.rdb.HMGet(ctx, keys[0], fields...).Result()
	if err != nil {
		return RefundResult{}, fmt.Errorf("billing: read txn: %w", err)
	}
	if vals[0] == nil {
		_ = tx.Commit(ctx)
		return RefundResult{Status: StatusNoTxn}, nil
	}
	type share struct {
		amount, before int64
		loaded         bool
	}
	shares := make([]share, len(legs))
	var total int64
	for i := range legs {
		k, _ := vals[1+3*i].(string)
		if k != keys[i+1] {
			return RefundResult{}, fmt.Errorf("billing: refund leg %d does not match the debit", i)
		}
		debited, err1 := parseInt(vals[2+3*i])
		before, err2 := parseInt(vals[3+3*i])
		if err1 != nil || err2 != nil {
			return RefundResult{}, fmt.Errorf("billing: malformed txn %s", keys[0])
		}
		amt := debited - before
		if amounts != nil {
			amt = min(amt, amounts[i])
		}
		if amt < 0 {
			amt = 0
		}
		shares[i] = share{amount: amt, before: before}
		total += amt
	}
	if total == 0 {
		_ = tx.Commit(ctx)
		return RefundResult{Status: StatusNothingToRefund}, nil
	}
	exists := make([]*redis.IntCmd, len(legs))
	if _, err := b.rdb.Pipelined(ctx, func(p redis.Pipeliner) error {
		for i := range legs {
			exists[i] = p.Exists(ctx, keys[i+1])
		}
		return nil
	}); err != nil {
		return RefundResult{}, fmt.Errorf("billing: exists: %w", err)
	}
	for i, l := range legs {
		sh := &shares[i]
		if sh.amount == 0 {
			continue
		}
		idem := "refund:" + txnID + ":" + l.OrgID
		if sh.before > 0 {
			idem += ":" + strconv.FormatInt(sh.before, 10)
		}
		if exists[i].Val() == 1 {
			// Loaded (the locks keep it from being evicted-and-reloaded under us).
			cr, err := b.Credit(ctx, l.Tag, l.OrgID, sh.amount, idem)
			if err != nil {
				return RefundResult{}, err
			}
			if cr.Status != StatusNotLoaded {
				sh.loaded = true
				continue
			}
		}
		ct, err := tx.Exec(ctx, `
			INSERT INTO balance_transactions (org_id, type, amount_micros, idempotency_key, reference, note, applied_at)
			VALUES ($1, 'REFUND', $2, $3, $4, 'engine refund (balance not loaded)', now())
			ON CONFLICT (idempotency_key) DO NOTHING`, l.OrgID, sh.amount, idem, txnID)
		if err != nil {
			return RefundResult{}, fmt.Errorf("billing: ledger refund insert: %w", err)
		}
		if ct.RowsAffected() == 1 {
			if _, err := tx.Exec(ctx, `UPDATE accounts_balance SET balance_micros = balance_micros + $2 WHERE org_id = $1`, l.OrgID, sh.amount); err != nil {
				return RefundResult{}, fmt.Errorf("billing: ledger refund update: %w", err)
			}
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return RefundResult{}, fmt.Errorf("billing: ledger refund commit: %w", err)
	}
	// Advance the txn's refunded counters (a retry after a failure here sees
	// the same "before" and hits the idempotency keys above).
	out := make([]int64, len(legs))
	if _, err := b.rdb.TxPipelined(ctx, func(p redis.Pipeliner) error {
		for i, sh := range shares {
			out[i] = sh.amount
			if sh.amount > 0 {
				p.HIncrBy(ctx, keys[0], "r"+strconv.Itoa(i+1), sh.amount)
			}
		}
		p.HSet(ctx, keys[0], "state", "REFUNDED_LEDGER")
		return nil
	}); err != nil {
		b.log.Error("ledger refund applied but txn record not updated", "txn", txnID, "err", err)
	}
	b.markDirty(ctx, legs)
	return RefundResult{Status: StatusOK, Refunded: out}, nil
}

// CreditResult is the outcome of Credit.
type CreditResult struct {
	Status  string // StatusOK, StatusDuplicate or StatusNotLoaded
	Balance *int64 // nil for NOT_LOADED
}

// Credit applies a signed top-up/adjustment to a LOADED balance, idempotent
// per idemKey (the balance_transactions.idempotency_key). It never hydrates:
// on NOT_LOADED the caller updates accounts_balance (CONTRACTS §6).
func (b *Biller) Credit(ctx context.Context, tag, orgID string, delta int64, idemKey string) (CreditResult, error) {
	if tag == "" || orgID == "" || idemKey == "" {
		return CreditResult{}, errors.New("billing: tag, org id and idempotency key required")
	}
	res, err := runScript(ctx, b.rdb, creditScript,
		[]string{BalanceKey(tag, orgID), CreditKey(tag, idemKey)}, []any{delta, b.idemTTL})
	if err != nil {
		return CreditResult{}, err
	}
	switch res.status {
	case StatusOK, StatusDuplicate:
		v, err := res.int(0)
		if err != nil {
			return CreditResult{}, err
		}
		if res.status == StatusOK {
			b.markDirty(ctx, []Leg{{OrgID: orgID, Tag: tag}})
		}
		return CreditResult{Status: res.status, Balance: &v}, nil
	case StatusNotLoaded:
		return CreditResult{Status: StatusNotLoaded}, nil
	default:
		return CreditResult{}, res.err("credit")
	}
}

// LoadResult is the outcome of Load.
type LoadResult struct {
	Status  string // StatusOK (hydrated now) or StatusAlreadyLoaded
	Balance int64
}

// Load hydrates one balance from accounts_balance via load.lua (never
// overwrites a live key). The accounts_balance row is locked FOR UPDATE
// while the key is written so a concurrent ledger update cannot interleave
// between the read and the Redis load.
func (b *Biller) Load(ctx context.Context, tag, orgID string) (LoadResult, error) {
	tx, err := b.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return LoadResult{}, fmt.Errorf("billing: hydrate begin: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after commit

	var (
		bal, limit       int64
		mode, role, prnt string
	)
	err = tx.QueryRow(ctx, `
		SELECT ab.balance_micros, ab.credit_limit_micros, ab.billing_mode::text,
		       o.role::text, coalesce(o.parent_id::text, '')
		  FROM accounts_balance ab
		  JOIN organizations o ON o.id = ab.org_id
		 WHERE ab.org_id = $1
		   FOR UPDATE OF ab`, orgID).Scan(&bal, &limit, &mode, &role, &prnt)
	if errors.Is(err, pgx.ErrNoRows) {
		return LoadResult{}, fmt.Errorf("%w %s", ErrNoAccount, orgID)
	}
	if err != nil {
		return LoadResult{}, fmt.Errorf("billing: hydrate read %s: %w", orgID, err)
	}
	if role == RoleSuperAdmin {
		return LoadResult{}, ErrNotBillable
	}
	if want := TagFor(role, orgID, prnt); want != tag {
		return LoadResult{}, fmt.Errorf("%w: org %s (%s) has tag %q, got %q", ErrTagMismatch, orgID, role, want, tag)
	}
	if mode != "POSTPAID" {
		limit = 0
	}
	res, err := runScript(ctx, b.rdb, loadScript, []string{BalanceKey(tag, orgID)}, []any{bal, limit})
	if err != nil {
		return LoadResult{}, err
	}
	if res.status != StatusOK && res.status != StatusAlreadyLoaded {
		return LoadResult{}, res.err("load")
	}
	v, err := res.int(0)
	if err != nil {
		return LoadResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		// The Redis key is loaded either way; the lock was all we needed.
		b.log.Warn("hydrate commit failed", "org_id", orgID, "err", err)
	}
	if res.status == StatusOK {
		b.log.Debug("balance hydrated", "org_id", orgID, "balance_micros", v, "limit_micros", limit)
	}
	return LoadResult{Status: res.status, Balance: v}, nil
}

// hydrateMissing loads every leg whose balance hash is absent.
func (b *Biller) hydrateMissing(ctx context.Context, legs []Leg) error {
	cmds := make([]*redis.IntCmd, len(legs))
	_, err := b.rdb.Pipelined(ctx, func(p redis.Pipeliner) error {
		for i, l := range legs {
			cmds[i] = p.Exists(ctx, BalanceKey(l.Tag, l.OrgID))
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("billing: exists: %w", err)
	}
	for i, l := range legs {
		if cmds[i].Val() == 1 {
			continue
		}
		if _, err := b.Load(ctx, l.Tag, l.OrgID); err != nil {
			if errors.Is(err, ErrNoAccount) {
				return policy.Wrap(policy.CodeInsufficientFunds, "no balance account", err)
			}
			return err
		}
	}
	return nil
}

// BalanceInfo is a live balance read.
type BalanceInfo struct {
	Balance int64 // micros
	Limit   int64 // overdraft micros (0 for prepaid)
	Loaded  bool  // true when read from Redis (always true after Balance)
}

// Balance returns the live Redis balance, hydrating it first if absent
// (CONTRACTS §5 GET /internal/v1/balance). Returns ErrNoAccount (wrapped)
// when the org has no accounts_balance row.
func (b *Biller) Balance(ctx context.Context, tag, orgID string) (BalanceInfo, error) {
	info, err := b.Peek(ctx, tag, orgID)
	if err != nil || info.Loaded {
		return info, err
	}
	if _, err := b.Load(ctx, tag, orgID); err != nil {
		return BalanceInfo{}, err
	}
	return b.Peek(ctx, tag, orgID)
}

// Peek reads the Redis balance without hydrating (Loaded=false if absent).
func (b *Biller) Peek(ctx context.Context, tag, orgID string) (BalanceInfo, error) {
	vals, err := b.rdb.HMGet(ctx, BalanceKey(tag, orgID), "bal", "limit").Result()
	if err != nil {
		return BalanceInfo{}, fmt.Errorf("billing: hmget: %w", err)
	}
	if vals[0] == nil {
		return BalanceInfo{}, nil
	}
	info := BalanceInfo{Loaded: true}
	if info.Balance, err = parseInt(vals[0]); err != nil {
		return BalanceInfo{}, err
	}
	if vals[1] != nil {
		if info.Limit, err = parseInt(vals[1]); err != nil {
			return BalanceInfo{}, err
		}
	}
	return info, nil
}

// SetLimit updates the overdraft limit of a loaded balance (call after a
// billing_mode / credit_limit_micros change). Returns false when the
// balance is not loaded (hydration will read the new limit).
func (b *Biller) SetLimit(ctx context.Context, tag, orgID string, limit int64) (bool, error) {
	if limit < 0 {
		return false, errors.New("billing: negative limit")
	}
	n, err := setLimitScript.Run(ctx, b.rdb, []string{BalanceKey(tag, orgID)}, limit).Int64()
	if err != nil {
		return false, fmt.Errorf("billing: set limit: %w", err)
	}
	return n == 1, nil
}

// LimitUpdate is one overdraft limit to apply (SetLimits).
type LimitUpdate struct {
	Tag, OrgID string
	Limit      int64 // >= 0
}

// SetLimits applies many limits to loaded balances (pipelined, 500 per
// round trip); balances that are not loaded are skipped (hydration reads
// the limit from Postgres). Returns how many loaded balances were updated.
func (b *Biller) SetLimits(ctx context.Context, ups []LimitUpdate) (int, error) {
	if len(ups) == 0 {
		return 0, nil
	}
	if err := setLimitScript.Load(ctx, b.rdb).Err(); err != nil {
		return 0, fmt.Errorf("billing: load set-limit script: %w", err)
	}
	updated := 0
	for start := 0; start < len(ups); start += 500 {
		batch := ups[start:min(start+500, len(ups))]
		cmds := make([]*redis.Cmd, len(batch))
		_, err := b.rdb.Pipelined(ctx, func(p redis.Pipeliner) error {
			for i, u := range batch {
				cmds[i] = setLimitScript.EvalSha(ctx, p, []string{BalanceKey(u.Tag, u.OrgID)}, max(u.Limit, 0))
			}
			return nil
		})
		if err != nil && !errors.Is(err, redis.Nil) {
			return updated, fmt.Errorf("billing: set limits: %w", err)
		}
		for _, c := range cmds {
			if n, err := c.Int64(); err == nil && n == 1 {
				updated++
			}
		}
	}
	return updated, nil
}

// Evict deletes a loaded balance after syncing it, forcing the next access
// to hydrate from Postgres. Used by tests and operational tooling.
func (b *Biller) Evict(ctx context.Context, tag, orgID string) error {
	return b.rdb.Del(ctx, BalanceKey(tag, orgID)).Err()
}

func (b *Biller) markDirty(ctx context.Context, legs []Leg) {
	members := make([]any, len(legs))
	for i, l := range legs {
		members[i] = dirtyMember(l.Tag, l.OrgID)
	}
	// The mutation already happened; a failed SADD only delays the write-back
	// until the Syncer's periodic full sweep.
	if err := b.rdb.SAdd(context.WithoutCancel(ctx), b.dirtyKey, members...).Err(); err != nil {
		b.log.Warn("mark dirty failed; full sweep will catch up", "err", err)
	}
}

// --- script plumbing ---------------------------------------------------------

type scriptResult struct {
	ok     bool
	status string
	rest   []any
}

// runScript executes s with EVALSHA, falling back to EVAL on NOSCRIPT
// (redis.Script.Run), and decodes the {ok, status, ...} reply.
func runScript(ctx context.Context, rdb redis.Scripter, s *redis.Script, keys []string, args []any) (scriptResult, error) {
	raw, err := s.Run(ctx, rdb, keys, args...).Result()
	if err != nil {
		return scriptResult{}, fmt.Errorf("billing: script: %w", err)
	}
	arr, ok := raw.([]any)
	if !ok || len(arr) < 2 {
		return scriptResult{}, fmt.Errorf("billing: unexpected script reply %#v", raw)
	}
	flag, _ := arr[0].(int64)
	status, _ := arr[1].(string)
	return scriptResult{ok: flag == 1, status: status, rest: arr[2:]}, nil
}

func (r scriptResult) arg(i int) string {
	if i >= len(r.rest) {
		return ""
	}
	switch v := r.rest[i].(type) {
	case string:
		return v
	case int64:
		return strconv.FormatInt(v, 10)
	default:
		return fmt.Sprint(v)
	}
}

func (r scriptResult) int(i int) (int64, error) {
	if i >= len(r.rest) {
		return 0, fmt.Errorf("billing: reply has no element %d", i)
	}
	return parseInt(r.rest[i])
}

func (r scriptResult) ints(n int) ([]int64, error) {
	if len(r.rest) != n {
		return nil, fmt.Errorf("billing: expected %d values, got %d", n, len(r.rest))
	}
	out := make([]int64, n)
	for i := range out {
		v, err := parseInt(r.rest[i])
		if err != nil {
			return nil, err
		}
		out[i] = v
	}
	return out, nil
}

func (r scriptResult) err(op string) error {
	return fmt.Errorf("billing: %s returned %s %v", op, r.status, r.rest)
}

func parseInt(v any) (int64, error) {
	switch x := v.(type) {
	case int64:
		return x, nil
	case string:
		if x == "" {
			return 0, nil // DUPLICATE on a since-evicted balance
		}
		n, err := strconv.ParseInt(x, 10, 64)
		if err != nil {
			return 0, fmt.Errorf("billing: bad integer %q", x)
		}
		return n, nil
	default:
		return 0, fmt.Errorf("billing: unexpected value %#v", v)
	}
}

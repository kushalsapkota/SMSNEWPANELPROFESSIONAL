package billing

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/redis/go-redis/v9"
)

// Syncer writes loaded Redis balances back to accounts_balance
// (balance_micros, synced_at). While a balance is loaded Redis is
// authoritative and the Syncer is the only writer of balance_micros
// (CONTRACTS §6).
//
// Correctness:
//   - Members are popped from the dirty set (SPOP) and re-added on any
//     failure, so a write-back is never lost. A debit that lands after the
//     pop re-adds its org, so the next cycle picks up the newer value.
//   - Balances and the Redis server clock are read in one MULTI/EXEC, and
//     rows are only updated when synced_at is older than that read time.
//     Two engine instances (or a slow cycle) can therefore never overwrite a
//     newer balance with an older one.
//   - A periodic full sweep enqueues every billable org, covering the window
//     where a process died between a mutation and its SADD.
//   - Orgs whose balance is not loaded are skipped (Postgres is authoritative
//     for them).
type Syncer struct {
	b         *Biller
	interval  time.Duration
	fullEvery time.Duration
	batch     int
	log       *slog.Logger
}

// SyncerOptions tune a Syncer.
type SyncerOptions struct {
	Interval  time.Duration // dirty-set drain period; default 2s
	FullEvery time.Duration // full sweep period; default 60s (<0 disables)
	Batch     int           // members per Redis/Postgres round trip; default 500
}

// NewSyncer creates a Syncer for b.
func NewSyncer(b *Biller, o SyncerOptions) *Syncer {
	if o.Interval <= 0 {
		o.Interval = 2 * time.Second
	}
	if o.FullEvery == 0 {
		o.FullEvery = 60 * time.Second
	}
	if o.Batch <= 0 {
		o.Batch = 500
	}
	return &Syncer{b: b, interval: o.Interval, fullEvery: o.FullEvery, batch: o.Batch, log: b.log.With("component", "balance-syncer")}
}

// Run syncs until ctx is cancelled, then performs a final flush (bounded by
// 5s) so a graceful shutdown persists the latest balances.
func (s *Syncer) Run(ctx context.Context) {
	t := time.NewTicker(s.interval)
	defer t.Stop()
	lastFull := time.Now()
	if s.fullEvery > 0 {
		if err := s.EnqueueAll(ctx); err != nil && ctx.Err() == nil {
			s.log.Warn("initial full sweep enqueue failed", "err", err)
		}
	}
	for {
		select {
		case <-ctx.Done():
			fctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			if _, err := s.SyncOnce(fctx); err != nil {
				s.log.Warn("final balance flush failed", "err", err)
			}
			cancel()
			return
		case <-t.C:
			if s.fullEvery > 0 && time.Since(lastFull) >= s.fullEvery {
				lastFull = time.Now()
				if err := s.EnqueueAll(ctx); err != nil && ctx.Err() == nil {
					s.log.Warn("full sweep enqueue failed", "err", err)
				}
			}
			if n, err := s.SyncOnce(ctx); err != nil && ctx.Err() == nil {
				s.log.Warn("balance sync failed", "err", err, "synced", n)
			}
		}
	}
}

// SyncOnce drains the dirty set completely and returns the number of rows
// written. On error the unsynced members are back in the dirty set.
func (s *Syncer) SyncOnce(ctx context.Context) (int, error) {
	total := 0
	for {
		members, err := s.b.rdb.SPopN(ctx, s.b.dirtyKey, int64(s.batch)).Result()
		if err != nil && err != redis.Nil {
			return total, fmt.Errorf("billing: spop dirty: %w", err)
		}
		if len(members) == 0 {
			return total, nil
		}
		n, err := s.syncMembers(ctx, members)
		total += n
		if err != nil {
			s.requeue(ctx, members)
			return total, err
		}
		if len(members) < s.batch {
			return total, nil
		}
	}
}

func (s *Syncer) requeue(ctx context.Context, members []string) {
	args := make([]any, len(members))
	for i, m := range members {
		args[i] = m
	}
	if err := s.b.rdb.SAdd(context.WithoutCancel(ctx), s.b.dirtyKey, args...).Err(); err != nil {
		s.log.Error("requeue dirty balances failed; full sweep will catch up", "err", err, "count", len(members))
	}
}

func (s *Syncer) syncMembers(ctx context.Context, members []string) (int, error) {
	type item struct{ tag, org string }
	items := make([]item, 0, len(members))
	for _, m := range members {
		tag, org, ok := parseDirtyMember(m)
		if !ok {
			s.log.Warn("dropping malformed dirty member", "member", m)
			continue
		}
		items = append(items, item{tag, org})
	}
	if len(items) == 0 {
		return 0, nil
	}
	var timeCmd *redis.TimeCmd
	gets := make([]*redis.StringCmd, len(items))
	_, err := s.b.rdb.TxPipelined(ctx, func(p redis.Pipeliner) error {
		timeCmd = p.Time(ctx)
		for i, it := range items {
			gets[i] = p.HGet(ctx, BalanceKey(it.tag, it.org), "bal")
		}
		return nil
	})
	if err != nil && err != redis.Nil {
		return 0, fmt.Errorf("billing: read balances: %w", err)
	}
	readAt, err := timeCmd.Result()
	if err != nil {
		return 0, fmt.Errorf("billing: redis time: %w", err)
	}
	orgs := make([]string, 0, len(items))
	bals := make([]int64, 0, len(items))
	for i, it := range items {
		v, err := gets[i].Int64()
		if err == redis.Nil {
			continue // not loaded: Postgres is authoritative
		}
		if err != nil {
			return 0, fmt.Errorf("billing: parse balance %s: %w", it.org, err)
		}
		orgs = append(orgs, it.org)
		bals = append(bals, v)
	}
	if len(orgs) == 0 {
		return 0, nil
	}
	tag, err := s.b.pool.Exec(ctx, `
		UPDATE accounts_balance ab
		   SET balance_micros = v.bal, synced_at = $3
		  FROM unnest($1::uuid[], $2::bigint[]) AS v(org_id, bal)
		 WHERE ab.org_id = v.org_id
		   AND (ab.synced_at IS NULL OR ab.synced_at < $3)`,
		orgs, bals, readAt.UTC())
	if err != nil {
		return 0, fmt.Errorf("billing: write balances: %w", err)
	}
	return int(tag.RowsAffected()), nil
}

// EnqueueAll adds every billable org (RESELLER and CLIENT with an
// accounts_balance row) to the dirty set.
func (s *Syncer) EnqueueAll(ctx context.Context) error {
	rows, err := s.b.pool.Query(ctx, `
		SELECT o.id::text, CASE WHEN o.role = 'CLIENT' THEN o.parent_id::text ELSE o.id::text END
		  FROM organizations o
		  JOIN accounts_balance ab ON ab.org_id = o.id
		 WHERE o.role <> 'SUPER_ADMIN'`)
	if err != nil {
		return fmt.Errorf("billing: list accounts: %w", err)
	}
	defer rows.Close()
	batch := make([]any, 0, s.batch)
	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		err := s.b.rdb.SAdd(ctx, s.b.dirtyKey, batch...).Err()
		batch = batch[:0]
		return err
	}
	for rows.Next() {
		var org, tag string
		if err := rows.Scan(&org, &tag); err != nil {
			return err
		}
		batch = append(batch, dirtyMember(tag, org))
		if len(batch) == cap(batch) {
			if err := flush(); err != nil {
				return err
			}
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	return flush()
}

// Package store keeps an in-memory, atomically swapped Snapshot of every
// configuration table the engine needs (CONTRACTS §6/§9), reloaded in full
// every ReloadInterval and shortly after any `cfg:invalidate` pubsub message.
//
// Readers call Current() (lock-free) and use the returned *Snapshot for the
// whole request. The dispatcher calls Subscribe() to learn which upstream
// connections were added, changed (needs rebind) or removed by a reload.
package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/redis/go-redis/v9"

	"smsgw/engine/internal/crypto"
)

// InvalidateChannel is the CONTRACTS §6 pubsub channel.
const InvalidateChannel = "cfg:invalidate"

// Invalidation is the CONTRACTS §6 message body.
type Invalidation struct {
	Entity string  `json:"entity"`
	ID     *string `json:"id"`
}

// DB is the subset of *pgxpool.Pool the store needs.
type DB interface {
	BeginTx(ctx context.Context, opts pgx.TxOptions) (pgx.Tx, error)
}

// Options tune a Store.
type Options struct {
	ReloadInterval time.Duration // full reload safety net; default 60s
	Debounce       time.Duration // quiet period after cfg:invalidate; default 200ms
	MaxDebounce    time.Duration // max delay under a continuous burst; default 2s
	Channel        string        // default InvalidateChannel
	Logger         *slog.Logger
}

// Store owns the current snapshot. Create with New, call Load once, then
// run Run in a goroutine.
type Store struct {
	db     DB
	rdb    redis.UniversalClient
	cipher *crypto.Cipher
	opts   Options
	log    *slog.Logger

	cur      atomic.Pointer[Snapshot]
	version  atomic.Uint64
	reloadMu sync.Mutex // serializes reloads

	invalidate chan struct{}

	subMu    sync.Mutex
	subs     map[*Subscription]struct{}
	notifies []chan struct{}

	reloads  atomic.Uint64
	failures atomic.Uint64
	lastErr  atomic.Pointer[errBox]
}

type errBox struct{ err error }

// New creates a Store. rdb may be nil (no pubsub; periodic reload only);
// cipher may be nil (secrets then carry PasswordErr/SecretErr).
func New(db DB, rdb redis.UniversalClient, cipher *crypto.Cipher, o Options) *Store {
	if o.ReloadInterval <= 0 {
		o.ReloadInterval = 60 * time.Second
	}
	if o.Debounce <= 0 {
		o.Debounce = 200 * time.Millisecond
	}
	if o.MaxDebounce < o.Debounce {
		o.MaxDebounce = 10 * o.Debounce
		if o.MaxDebounce < 2*time.Second {
			o.MaxDebounce = 2 * time.Second
		}
	}
	if o.Channel == "" {
		o.Channel = InvalidateChannel
	}
	if o.Logger == nil {
		o.Logger = slog.Default()
	}
	return &Store{
		db: db, rdb: rdb, cipher: cipher, opts: o,
		log:        o.Logger.With("component", "store"),
		invalidate: make(chan struct{}, 1),
		subs:       make(map[*Subscription]struct{}),
	}
}

// Current returns the latest snapshot (nil before the first successful Load).
func (s *Store) Current() *Snapshot { return s.cur.Load() }

// Stats reports reload counters and the last reload error (nil if the last
// reload succeeded).
func (s *Store) Stats() (reloads, failures uint64, lastErr error) {
	if b := s.lastErr.Load(); b != nil {
		lastErr = b.err
	}
	return s.reloads.Load(), s.failures.Load(), lastErr
}

// Load performs a synchronous full reload. The previous snapshot stays in
// place on error.
func (s *Store) Load(ctx context.Context) error {
	s.reloadMu.Lock()
	defer s.reloadMu.Unlock()
	start := time.Now()
	d, err := LoadData(ctx, s.db, s.cipher)
	if err != nil {
		s.failures.Add(1)
		s.lastErr.Store(&errBox{err})
		return err
	}
	snap := NewSnapshot(*d)
	snap.Version = s.version.Add(1)
	old := s.cur.Swap(snap)
	s.reloads.Add(1)
	s.lastErr.Store(&errBox{nil})
	if old == nil || len(old.Warnings) != len(snap.Warnings) {
		for _, w := range snap.Warnings {
			s.log.Warn("config warning", "warning", w)
		}
	}
	s.log.Debug("config reloaded", "version", snap.Version, "took", time.Since(start),
		"orgs", len(d.Orgs), "routes", len(d.Routes), "connections", len(d.Connections))
	if old != nil {
		if diff := DiffConnections(old, snap); !diff.Empty() {
			s.publish(diff)
		}
	}
	s.subMu.Lock()
	for _, ch := range s.notifies {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
	s.subMu.Unlock()
	return nil
}

// Notify returns a channel signalled (coalesced, never blocking the store)
// after every successful reload; compare Current() with what you last saw.
func (s *Store) Notify() <-chan struct{} {
	ch := make(chan struct{}, 1)
	s.subMu.Lock()
	s.notifies = append(s.notifies, ch)
	s.subMu.Unlock()
	return ch
}

// Invalidate schedules a debounced reload (what a cfg:invalidate message does).
func (s *Store) Invalidate() {
	select {
	case s.invalidate <- struct{}{}:
	default:
	}
}

// Run drives reloads until ctx is done: every ReloadInterval, after a
// debounced burst of Invalidate calls / cfg:invalidate messages, and after
// every (re)subscription to the pubsub channel (messages may have been
// missed while disconnected). Reload errors are logged; the previous
// snapshot keeps serving.
func (s *Store) Run(ctx context.Context) {
	var wg sync.WaitGroup
	if s.rdb != nil {
		wg.Add(1)
		go func() { defer wg.Done(); s.listen(ctx) }()
	}
	defer wg.Wait()

	ticker := time.NewTicker(s.opts.ReloadInterval)
	defer ticker.Stop()
	var (
		quiet    *time.Timer
		quietC   <-chan time.Time
		deadline time.Time
	)
	reload := func(reason string) {
		if quiet != nil {
			quiet.Stop()
			quiet, quietC = nil, nil
		}
		if err := s.Load(ctx); err != nil && ctx.Err() == nil {
			s.log.Error("config reload failed; keeping previous snapshot", "reason", reason, "err", err)
		}
	}
	for {
		select {
		case <-ctx.Done():
			if quiet != nil {
				quiet.Stop()
			}
			return
		case <-ticker.C:
			reload("interval")
		case <-s.invalidate:
			now := time.Now()
			if quiet == nil {
				deadline = now.Add(s.opts.MaxDebounce)
				quiet = time.NewTimer(s.opts.Debounce)
				quietC = quiet.C
				continue
			}
			// Trailing debounce, capped so a constant stream still reloads.
			wait := s.opts.Debounce
			if rem := deadline.Sub(now); rem < wait {
				wait = rem
			}
			if !quiet.Stop() {
				select {
				case <-quiet.C:
				default:
				}
			}
			if wait <= 0 {
				reload("invalidate")
				continue
			}
			quiet.Reset(wait)
		case <-quietC:
			quiet, quietC = nil, nil
			reload("invalidate")
		}
	}
}

func (s *Store) listen(ctx context.Context) {
	ps := s.rdb.Subscribe(ctx, s.opts.Channel)
	// PubSub.Receive blocks on the socket and ignores ctx; closing the
	// PubSub is what unblocks it on shutdown.
	stop := context.AfterFunc(ctx, func() { _ = ps.Close() })
	defer stop()
	defer ps.Close()
	for {
		msg, err := ps.Receive(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			// go-redis reconnects and resubscribes on the next Receive.
			s.log.Warn("cfg:invalidate receive failed", "err", err)
			select {
			case <-ctx.Done():
				return
			case <-time.After(500 * time.Millisecond):
			}
			continue
		}
		switch m := msg.(type) {
		case *redis.Subscription:
			if m.Kind == "subscribe" {
				// (Re)subscribed: anything published while we were away is lost.
				s.Invalidate()
			}
		case *redis.Message:
			var inv Invalidation
			if err := json.Unmarshal([]byte(m.Payload), &inv); err != nil {
				s.log.Warn("malformed cfg:invalidate payload; reloading anyway", "payload", m.Payload)
			} else {
				s.log.Debug("cfg:invalidate", "entity", inv.Entity, "id", inv.ID)
			}
			// Full reload for every entity: config tables are small, and a
			// consistent snapshot across tables beats partial patching.
			s.Invalidate()
		case *redis.Pong:
		}
	}
}

// --- connection change subscriptions -----------------------------------------

// ConnDiff describes how upstream connections changed between two snapshots.
type ConnDiff struct {
	Old, New *Snapshot
	Added    []string // in New only
	Updated  []string // in both, ConfigEqual false (rebind only if SessionConfigEqual is false too)
	Removed  []string // in Old only
}

// Empty reports whether nothing changed.
func (d ConnDiff) Empty() bool { return len(d.Added)+len(d.Updated)+len(d.Removed) == 0 }

// DiffConnections compares the upstream connections of two snapshots.
func DiffConnections(old, new *Snapshot) ConnDiff {
	d := ConnDiff{Old: old, New: new}
	if new == nil {
		return d
	}
	for id, nc := range new.connections {
		var oc *Connection
		if old != nil {
			oc = old.connections[id]
		}
		switch {
		case oc == nil:
			d.Added = append(d.Added, id)
		case !oc.ConfigEqual(nc):
			d.Updated = append(d.Updated, id)
		}
	}
	if old != nil {
		for id := range old.connections {
			if new.connections[id] == nil {
				d.Removed = append(d.Removed, id)
			}
		}
	}
	sort.Strings(d.Added)
	sort.Strings(d.Updated)
	sort.Strings(d.Removed)
	return d
}

// Subscription delivers connection diffs. C never blocks the store: if the
// consumer falls behind, pending diffs are merged into one covering the
// whole interval (Old of the first, New of the latest).
type Subscription struct {
	C  <-chan ConnDiff
	ch chan ConnDiff
	mu sync.Mutex
	s  *Store
}

// Subscribe registers a connection-change subscriber. Call Close when done.
func (s *Store) Subscribe() *Subscription {
	ch := make(chan ConnDiff, 1)
	sub := &Subscription{C: ch, ch: ch, s: s}
	s.subMu.Lock()
	s.subs[sub] = struct{}{}
	s.subMu.Unlock()
	return sub
}

// Close unregisters the subscription. C is not closed (a concurrent publish
// may still deliver one last value).
func (sub *Subscription) Close() {
	sub.s.subMu.Lock()
	delete(sub.s.subs, sub)
	sub.s.subMu.Unlock()
}

func (s *Store) publish(d ConnDiff) {
	s.subMu.Lock()
	subs := make([]*Subscription, 0, len(s.subs))
	for sub := range s.subs {
		subs = append(subs, sub)
	}
	s.subMu.Unlock()
	for _, sub := range subs {
		sub.deliver(d)
	}
}

func (sub *Subscription) deliver(d ConnDiff) {
	sub.mu.Lock()
	defer sub.mu.Unlock()
	select {
	case prev := <-sub.ch:
		// Recompute across the whole interval. If the changes cancelled out
		// (edited then reverted) the merged diff is empty; it is still
		// delivered so the consumer reconciles against the latest snapshot.
		d = DiffConnections(prev.Old, d.New)
	default:
	}
	// We are the only sender and just drained (or found empty) the buffer.
	sub.ch <- d
}

// ErrNotLoaded is returned by MustCurrent before the first load.
var ErrNotLoaded = errors.New("store: no snapshot loaded")

// MustCurrent returns the current snapshot or ErrNotLoaded.
func (s *Store) MustCurrent() (*Snapshot, error) {
	if c := s.cur.Load(); c != nil {
		return c, nil
	}
	return nil, ErrNotLoaded
}

// String implements fmt.Stringer for debugging.
func (d ConnDiff) String() string {
	return fmt.Sprintf("added=%v updated=%v removed=%v", d.Added, d.Updated, d.Removed)
}

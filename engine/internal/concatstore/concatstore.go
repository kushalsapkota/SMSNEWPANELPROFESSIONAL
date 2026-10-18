// Package concatstore is a Redis-backed server.ConcatStore: incomplete
// client multipart sets live in one hash per set, so the parts of a message
// submitted on binds held by different engine instances join, and an
// engine restart does not lose acknowledged parts.
//
// Key: cc:<system_id>:<sha256(src|dst|kind|ref|total)[:32]> (TTL = the
// server's ConcatTimeout from the first part). Fields: id (set message id),
// n (parts received), first_ms, meta (template message), p<seq> (payload),
// h<seq> (received flag), i<seq> (message id returned for the part).
package concatstore

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"smsgw/engine/internal/smpp/server"
)

// addSrc: KEYS[1] set hash; ARGV seq, total, data, meta, new set id,
// new part id ("" = reuse the set id), ttl ms, now ms, "1" if seq is 1.
// Returns {0, set id, part id} or, when complete (the hash is deleted),
// {1, set id, part id, meta, first_ms, p1, i1, ..., pN, iN}.
var addScript = redis.NewScript(`
local k = KEYS[1]
local seq = ARGV[1]
local total = tonumber(ARGV[2])
if redis.call('HSETNX', k, 'id', ARGV[5]) == 1 then
  redis.call('HSET', k, 'first_ms', ARGV[8], 'n', 0)
  redis.call('PEXPIRE', k, ARGV[7])
end
local id = redis.call('HGET', k, 'id')
local pid = redis.call('HGET', k, 'i' .. seq)
if not pid then
  if ARGV[6] ~= '' and tonumber(redis.call('HGET', k, 'n') or '0') > 0 then pid = ARGV[6] else pid = id end
  redis.call('HSET', k, 'i' .. seq, pid)
end
if redis.call('HSETNX', k, 'h' .. seq, 1) == 1 then redis.call('HINCRBY', k, 'n', 1) end
redis.call('HSET', k, 'p' .. seq, ARGV[3])
if ARGV[9] == '1' or redis.call('HEXISTS', k, 'meta') == 0 then redis.call('HSET', k, 'meta', ARGV[4]) end
if tonumber(redis.call('HGET', k, 'n')) < total then return {0, id, pid} end
local out = {1, id, pid, redis.call('HGET', k, 'meta'), redis.call('HGET', k, 'first_ms')}
for i = 1, total do
  out[#out + 1] = redis.call('HGET', k, 'p' .. i) or ''
  out[#out + 1] = redis.call('HGET', k, 'i' .. i) or ''
end
redis.call('DEL', k)
return out`)

// rearmSrc: KEYS[1] set hash; ARGV new set id, meta, first_ms, ttl ms,
// excluded seq, total, then p1, i1, ..., pN, iN. Returns 1, or 0 if a set
// with this key exists already.
var rearmScript = redis.NewScript(`
local k = KEYS[1]
if redis.call('EXISTS', k) == 1 then return 0 end
local skip = tonumber(ARGV[5])
local total = tonumber(ARGV[6])
redis.call('HSET', k, 'id', ARGV[1], 'meta', ARGV[2], 'first_ms', ARGV[3], 'n', total - 1)
for i = 1, total do
  if i ~= skip then
    redis.call('HSET', k, 'p' .. i, ARGV[5 + 2 * i], 'i' .. i, ARGV[6 + 2 * i], 'h' .. i, 1)
  end
end
redis.call('PEXPIRE', k, ARGV[4])
return 1`)

// Store implements server.ConcatStore.
type Store struct {
	rdb    redis.UniversalClient
	prefix string
}

// New creates a Store; prefix defaults to "cc:".
func New(rdb redis.UniversalClient, prefix string) *Store {
	if prefix == "" {
		prefix = "cc:"
	}
	return &Store{rdb: rdb, prefix: prefix}
}

// Key returns the Redis key of a set.
func (s *Store) Key(k server.ConcatKey) string {
	h := sha256.Sum256([]byte(fmt.Sprintf("%s|%s|%s|%d|%d", k.Src, k.Dst, k.Kind, k.Ref, k.Total)))
	return s.prefix + k.SystemID + ":" + hex.EncodeToString(h[:16])
}

// AddPart implements server.ConcatStore.
func (s *Store) AddPart(ctx context.Context, key server.ConcatKey, p server.ConcatPart) (server.ConcatResult, error) {
	if p.Seq < 1 || p.Seq > int(key.Total) {
		return server.ConcatResult{}, fmt.Errorf("concatstore: part %d of %d", p.Seq, key.Total)
	}
	ttl := p.TTL
	if ttl <= 0 {
		ttl = time.Minute
	}
	now := p.Now
	if now.IsZero() {
		now = time.Now()
	}
	first := "0"
	if p.Seq == 1 {
		first = "1"
	}
	raw, err := addScript.Run(ctx, s.rdb, []string{s.Key(key)}, p.Seq, int(key.Total), p.Data, p.Meta,
		p.NewSetID, p.NewPartID, ttl.Milliseconds(), now.UnixMilli(), first).Slice()
	if err != nil {
		return server.ConcatResult{}, fmt.Errorf("concatstore: add: %w", err)
	}
	str := func(i int) string {
		if i < len(raw) {
			v, _ := raw[i].(string)
			return v
		}
		return ""
	}
	if len(raw) < 3 {
		return server.ConcatResult{}, fmt.Errorf("concatstore: unexpected reply %v", raw)
	}
	res := server.ConcatResult{SetID: str(1), PartID: str(2)}
	if done, _ := raw[0].(int64); done != 1 {
		return res, nil
	}
	n := int(key.Total)
	if len(raw) != 5+2*n {
		return server.ConcatResult{}, fmt.Errorf("concatstore: unexpected completion reply length %d", len(raw))
	}
	res.Complete = true
	res.Meta = []byte(str(3))
	if ms, err := strconv.ParseInt(str(4), 10, 64); err == nil {
		res.FirstSeen = time.UnixMilli(ms)
	}
	res.Parts = make([][]byte, n)
	res.PartIDs = make([]string, n)
	for i := 0; i < n; i++ {
		res.Parts[i] = []byte(str(5 + 2*i))
		res.PartIDs[i] = str(6 + 2*i)
	}
	return res, nil
}

// Rearm implements server.ConcatStore.
func (s *Store) Rearm(ctx context.Context, key server.ConcatKey, res server.ConcatResult, seq int, newSetID string, ttl time.Duration) error {
	n := int(key.Total)
	if len(res.Parts) != n || len(res.PartIDs) != n {
		return fmt.Errorf("concatstore: rearm with %d parts of %d", len(res.Parts), n)
	}
	if ttl <= 0 {
		ttl = time.Minute
	}
	args := []any{newSetID, res.Meta, res.FirstSeen.UnixMilli(), ttl.Milliseconds(), seq, n}
	for i := 0; i < n; i++ {
		id := res.PartIDs[i]
		if i == seq-1 {
			id = ""
		}
		args = append(args, res.Parts[i], id)
	}
	if err := rearmScript.Run(ctx, s.rdb, []string{s.Key(key)}, args...).Err(); err != nil {
		return fmt.Errorf("concatstore: rearm: %w", err)
	}
	return nil
}

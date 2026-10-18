package crypto

import (
	"crypto/sha256"
	"sync"
	"time"
)

// DefaultBindCacheTTL is the CONTRACTS §2 lifetime of a cached SMPP bind.
const DefaultBindCacheTTL = 10 * time.Minute

// BindCache remembers successful SMPP bind verifications so a reconnect storm
// does not cost one argon2id evaluation (~20 MiB, tens of ms) per bind.
//
// The key is sha256(system_id | "|" | password | "|" | password_hash): a
// password rotation changes password_hash, so stale entries can never
// authenticate the old password against a new hash. Only successes are
// cached. Safe for concurrent use.
type BindCache struct {
	ttl     time.Duration
	maxSize int
	now     func() time.Time

	mu      sync.Mutex
	entries map[[32]byte]time.Time // key -> expiry
	sweepAt time.Time
}

// NewBindCache creates a cache. ttl<=0 uses DefaultBindCacheTTL; maxSize<=0
// uses 100k entries (when full, expired entries are swept and, failing that,
// the cache is cleared — correctness never depends on a hit).
func NewBindCache(ttl time.Duration, maxSize int) *BindCache {
	if ttl <= 0 {
		ttl = DefaultBindCacheTTL
	}
	if maxSize <= 0 {
		maxSize = 100_000
	}
	return &BindCache{ttl: ttl, maxSize: maxSize, now: time.Now, entries: make(map[[32]byte]time.Time)}
}

func bindKey(systemID, password, passwordHash string) [32]byte {
	h := sha256.New()
	h.Write([]byte(systemID))
	h.Write([]byte{'|'})
	h.Write([]byte(password))
	h.Write([]byte{'|'})
	h.Write([]byte(passwordHash))
	var k [32]byte
	h.Sum(k[:0])
	return k
}

// Verify returns whether password matches passwordHash for systemID, using
// the cache for previously successful combinations. A malformed hash returns
// (false, ErrBadHash).
func (c *BindCache) Verify(systemID, password, passwordHash string) (bool, error) {
	k := bindKey(systemID, password, passwordHash)
	now := c.now()
	c.mu.Lock()
	exp, ok := c.entries[k]
	c.mu.Unlock()
	if ok && now.Before(exp) {
		return true, nil
	}
	match, err := VerifyPassword(password, passwordHash)
	if err != nil || !match {
		return false, err
	}
	c.mu.Lock()
	c.insertLocked(k, now)
	c.mu.Unlock()
	return true, nil
}

func (c *BindCache) insertLocked(k [32]byte, now time.Time) {
	if len(c.entries) >= c.maxSize || now.After(c.sweepAt) {
		for key, exp := range c.entries {
			if !now.Before(exp) {
				delete(c.entries, key)
			}
		}
		c.sweepAt = now.Add(c.ttl)
		if len(c.entries) >= c.maxSize {
			clear(c.entries)
		}
	}
	c.entries[k] = now.Add(c.ttl)
}

// Forget drops every cached entry (e.g. after an SMPP password rotation the
// hash changes anyway, but operators may want an explicit flush).
func (c *BindCache) Forget() {
	c.mu.Lock()
	clear(c.entries)
	c.mu.Unlock()
}

// Len returns the number of cached entries (including not-yet-swept expired ones).
func (c *BindCache) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.entries)
}

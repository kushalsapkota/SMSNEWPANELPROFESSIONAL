package crypto

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"golang.org/x/crypto/argon2"
)

// Argon2id parameters matching @node-rs/argon2 defaults (CONTRACTS §2).
const (
	Argon2Memory  uint32 = 19456 // KiB
	Argon2Time    uint32 = 2
	Argon2Threads uint8  = 1
	Argon2SaltLen        = 16
	Argon2KeyLen         = 32
)

// Upper bounds accepted when verifying foreign hashes, so a hostile row
// cannot make Verify allocate gigabytes or spin for minutes.
const (
	maxVerifyMemory = 1 << 20 // 1 GiB in KiB
	maxVerifyTime   = 64
	maxVerifyKeyLen = 1024
)

// ErrBadHash means the stored hash is not a parseable argon2id PHC string.
var ErrBadHash = errors.New("crypto: malformed argon2id hash")

// PHC holds the parsed fields of an argon2id PHC string.
type PHC struct {
	Version uint32
	Memory  uint32
	Time    uint32
	Threads uint8
	Salt    []byte
	Hash    []byte
}

// HashPassword returns "$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>" with
// unpadded std base64 fields, exactly like @node-rs/argon2.
func HashPassword(password string) (string, error) {
	salt := make([]byte, Argon2SaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("crypto: salt: %w", err)
	}
	return hashWithSalt(password, salt), nil
}

func hashWithSalt(password string, salt []byte) string {
	key := argon2.IDKey([]byte(password), salt, Argon2Time, Argon2Memory, Argon2Threads, Argon2KeyLen)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, Argon2Memory, Argon2Time, Argon2Threads,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key))
}

// ParsePHC parses an argon2id PHC string. The version segment is optional
// (pre-1.3 encoders omit it); parameters may appear in any order.
func ParsePHC(encoded string) (*PHC, error) {
	parts := strings.Split(encoded, "$")
	// "", "argon2id", ["v=19"], "m=..,t=..,p=..", salt, hash
	if len(parts) != 5 && len(parts) != 6 {
		return nil, ErrBadHash
	}
	if parts[0] != "" || parts[1] != "argon2id" {
		return nil, ErrBadHash
	}
	p := &PHC{Version: 0x10}
	idx := 2
	if len(parts) == 6 {
		v, ok := strings.CutPrefix(parts[2], "v=")
		if !ok {
			return nil, ErrBadHash
		}
		n, err := strconv.ParseUint(v, 10, 32)
		if err != nil {
			return nil, ErrBadHash
		}
		p.Version = uint32(n)
		idx = 3
	}
	if p.Version != argon2.Version {
		// x/crypto only implements v=19 (0x13).
		return nil, fmt.Errorf("%w: unsupported version %d", ErrBadHash, p.Version)
	}
	var haveM, haveT, haveP bool
	for _, kv := range strings.Split(parts[idx], ",") {
		k, v, ok := strings.Cut(kv, "=")
		if !ok {
			return nil, ErrBadHash
		}
		n, err := strconv.ParseUint(v, 10, 32)
		if err != nil {
			return nil, ErrBadHash
		}
		switch k {
		case "m":
			p.Memory, haveM = uint32(n), true
		case "t":
			p.Time, haveT = uint32(n), true
		case "p":
			if n == 0 || n > 255 {
				return nil, ErrBadHash
			}
			p.Threads, haveP = uint8(n), true
		default:
			// Unknown params (e.g. keyid/data) are not produced by node-rs; reject.
			return nil, ErrBadHash
		}
	}
	if !haveM || !haveT || !haveP || p.Time == 0 || p.Memory < 8*uint32(p.Threads) {
		return nil, ErrBadHash
	}
	if p.Memory > maxVerifyMemory || p.Time > maxVerifyTime {
		return nil, fmt.Errorf("%w: parameters too expensive", ErrBadHash)
	}
	var err error
	if p.Salt, err = decodeB64(parts[idx+1]); err != nil || len(p.Salt) < 8 {
		return nil, ErrBadHash
	}
	if p.Hash, err = decodeB64(parts[idx+2]); err != nil || len(p.Hash) < 4 || len(p.Hash) > maxVerifyKeyLen {
		return nil, ErrBadHash
	}
	return p, nil
}

func decodeB64(s string) ([]byte, error) {
	return base64.RawStdEncoding.DecodeString(strings.TrimRight(s, "="))
}

// VerifyPassword checks password against an argon2id PHC string using a
// constant-time comparison. A malformed hash returns (false, ErrBadHash).
func VerifyPassword(password, encoded string) (bool, error) {
	p, err := ParsePHC(encoded)
	if err != nil {
		return false, err
	}
	key := argon2.IDKey([]byte(password), p.Salt, p.Time, p.Memory, p.Threads, uint32(len(p.Hash)))
	return subtle.ConstantTimeCompare(key, p.Hash) == 1, nil
}

// NeedsRehash reports whether encoded was produced with parameters other
// than the current defaults.
func NeedsRehash(encoded string) bool {
	p, err := ParsePHC(encoded)
	if err != nil {
		return true
	}
	return p.Memory != Argon2Memory || p.Time != Argon2Time || p.Threads != Argon2Threads ||
		len(p.Salt) != Argon2SaltLen || len(p.Hash) != Argon2KeyLen
}

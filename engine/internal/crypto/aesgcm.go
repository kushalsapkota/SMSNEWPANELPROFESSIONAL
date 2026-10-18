// Package crypto implements the shared crypto formats of CONTRACTS §2 so the
// Go engine interoperates byte-for-byte with the NestJS api:
//
//   - `*_enc` columns: "v1:" + base64std(nonce(12) || ciphertext || tag(16)),
//     AES-256-GCM, key = base64-decoded APP_ENC_KEY, no AAD.
//   - Passwords: argon2id PHC strings with the @node-rs/argon2 defaults
//     (m=19456 KiB, t=2, p=1, 16-byte salt, 32-byte hash).
//   - An in-memory TTL cache of successful SMPP bind verifications.
package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
)

const (
	encPrefix = "v1:"
	nonceSize = 12
	tagSize   = 16
	// KeySize is the required APP_ENC_KEY length in bytes (AES-256).
	KeySize = 32
)

var (
	// ErrBadKey means the key is not exactly 32 bytes.
	ErrBadKey = errors.New("crypto: AES-256 key must be 32 bytes")
	// ErrBadFormat means the ciphertext string is not a well-formed "v1:" value.
	ErrBadFormat = errors.New("crypto: malformed encrypted value")
	// ErrDecrypt means authentication failed (wrong key or tampered data).
	ErrDecrypt = errors.New("crypto: decryption failed")
)

// Cipher encrypts/decrypts the "v1:" format. It is safe for concurrent use.
type Cipher struct {
	aead cipher.AEAD
}

// NewCipher builds a Cipher from a raw 32-byte key.
func NewCipher(key []byte) (*Cipher, error) {
	if len(key) != KeySize {
		return nil, ErrBadKey
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("crypto: %w", err)
	}
	aead, err := cipher.NewGCM(block) // 12-byte nonce, 16-byte tag
	if err != nil {
		return nil, fmt.Errorf("crypto: %w", err)
	}
	return &Cipher{aead: aead}, nil
}

// ParseKey decodes a base64 (std, with or without padding) APP_ENC_KEY.
func ParseKey(b64 string) ([]byte, error) {
	s := strings.TrimSpace(b64)
	key, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		key, err = base64.RawStdEncoding.DecodeString(strings.TrimRight(s, "="))
		if err != nil {
			return nil, fmt.Errorf("crypto: APP_ENC_KEY is not valid base64: %w", err)
		}
	}
	if len(key) != KeySize {
		return nil, fmt.Errorf("crypto: APP_ENC_KEY must decode to %d bytes, got %d", KeySize, len(key))
	}
	return key, nil
}

// Encrypt returns "v1:" + base64std(nonce || ciphertext || tag).
func (c *Cipher) Encrypt(plaintext []byte) (string, error) {
	nonce := make([]byte, nonceSize, nonceSize+len(plaintext)+tagSize)
	if _, err := rand.Read(nonce); err != nil {
		return "", fmt.Errorf("crypto: nonce: %w", err)
	}
	out := c.aead.Seal(nonce, nonce, plaintext, nil)
	return encPrefix + base64.StdEncoding.EncodeToString(out), nil
}

// EncryptString is Encrypt for string plaintexts.
func (c *Cipher) EncryptString(plaintext string) (string, error) {
	return c.Encrypt([]byte(plaintext))
}

// Decrypt parses and authenticates a "v1:" value.
func (c *Cipher) Decrypt(value string) ([]byte, error) {
	if !strings.HasPrefix(value, encPrefix) {
		return nil, ErrBadFormat
	}
	raw, err := base64.StdEncoding.DecodeString(value[len(encPrefix):])
	if err != nil {
		return nil, ErrBadFormat
	}
	if len(raw) < nonceSize+tagSize {
		return nil, ErrBadFormat
	}
	pt, err := c.aead.Open(nil, raw[:nonceSize], raw[nonceSize:], nil)
	if err != nil {
		return nil, ErrDecrypt
	}
	return pt, nil
}

// DecryptString is Decrypt returning a string.
func (c *Cipher) DecryptString(value string) (string, error) {
	pt, err := c.Decrypt(value)
	if err != nil {
		return "", err
	}
	return string(pt), nil
}

// Encrypt is a convenience wrapper using a raw key.
func Encrypt(key, plaintext []byte) (string, error) {
	c, err := NewCipher(key)
	if err != nil {
		return "", err
	}
	return c.Encrypt(plaintext)
}

// Decrypt is a convenience wrapper using a raw key.
func Decrypt(key []byte, value string) ([]byte, error) {
	c, err := NewCipher(key)
	if err != nil {
		return nil, err
	}
	return c.Decrypt(value)
}

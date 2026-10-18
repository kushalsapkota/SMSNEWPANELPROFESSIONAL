// Package phone normalizes MSISDNs and sender addresses (CONTRACTS §3) and
// maps E.164 numbers to ISO 3166-1 alpha-2 country codes.
package phone

import (
	"strings"
	"unicode"

	"smsgw/engine/internal/policy"
)

const (
	minMSISDN = 6
	maxMSISDN = 15
	maxAlnum  = 11
)

// SMPP type-of-number / numbering-plan values used for source addresses.
const (
	TONUnknown       uint8 = 0
	TONInternational uint8 = 1
	TONNational      uint8 = 2
	TONNetwork       uint8 = 3 // network specific: short codes
	TONSubscriber    uint8 = 4
	TONAlphanumeric  uint8 = 5
	TONAbbreviated   uint8 = 6

	NPIUnknown uint8 = 0
	NPIE164    uint8 = 1
)

// isSeparator reports characters stripped from MSISDN input: '+', whitespace
// (including NBSP), dashes, and — as a lenient, backward-compatible extension
// of CONTRACTS §3 — parentheses and dots ("+1 (555) 123-4567", "91.98765.43210").
func isSeparator(r rune) bool {
	switch r {
	case '+', '-', '(', ')', '.', '‐', '‑', '‒', '–', '—', '−':
		return true
	}
	return unicode.IsSpace(r)
}

// NormalizeMSISDN strips separators and returns digits only (E.164 without
// '+'). Anything other than 6–15 ASCII digits afterwards is rejected with
// INVALID_DESTINATION. Only one leading '+' is accepted.
func NormalizeMSISDN(in string) (string, error) {
	s := strings.TrimSpace(in)
	if strings.Count(s, "+") > 1 || (strings.Contains(s, "+") && !strings.HasPrefix(s, "+")) {
		return "", policy.Errorf(policy.CodeInvalidDestination, "invalid destination %q", in)
	}
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		switch {
		case r >= '0' && r <= '9':
			b.WriteRune(r)
		case isSeparator(r):
		default:
			return "", policy.Errorf(policy.CodeInvalidDestination, "invalid destination %q", in)
		}
	}
	d := b.String()
	if len(d) < minMSISDN || len(d) > maxMSISDN {
		return "", policy.Errorf(policy.CodeInvalidDestination, "destination must be %d-%d digits", minMSISDN, maxMSISDN)
	}
	return d, nil
}

// Sender is a classified source address.
type Sender struct {
	TON        uint8
	NPI        uint8
	Normalized string // digits only for numeric senders, trimmed text for alphanumeric
}

// ClassifySender applies CONTRACTS §3:
//
//	alphanumeric (≤11 chars, contains a letter)  → TON 5, NPI 0
//	numeric ≥ 9 digits (leading '+' stripped)    → TON 1, NPI 1 (max 15 digits)
//	numeric ≤ 8 digits (short code)              → TON 3, NPI 0
//
// Alphanumeric senders may contain printable ASCII (letters, digits, space
// and punctuation); a '+' prefix is only meaningful for numeric senders.
// Invalid senders return SENDER_NOT_ALLOWED.
func ClassifySender(in string) (Sender, error) {
	s := strings.TrimSpace(in)
	if s == "" {
		return Sender{}, policy.New(policy.CodeSenderNotAllowed, "sender is required")
	}
	digits := strings.TrimPrefix(s, "+")
	if digits != "" && allDigits(digits) {
		switch {
		case len(digits) > maxMSISDN:
			return Sender{}, policy.Errorf(policy.CodeSenderNotAllowed, "numeric sender longer than %d digits", maxMSISDN)
		case len(digits) >= 9:
			return Sender{TON: TONInternational, NPI: NPIE164, Normalized: digits}, nil
		default:
			return Sender{TON: TONNetwork, NPI: NPIUnknown, Normalized: digits}, nil
		}
	}
	if strings.HasPrefix(s, "+") {
		return Sender{}, policy.Errorf(policy.CodeSenderNotAllowed, "invalid sender %q", in)
	}
	n, hasLetter := 0, false
	for _, r := range s {
		n++
		if r < 0x20 || r > 0x7e {
			return Sender{}, policy.Errorf(policy.CodeSenderNotAllowed, "invalid character in sender %q", in)
		}
		if (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') {
			hasLetter = true
		}
	}
	if n > maxAlnum {
		return Sender{}, policy.Errorf(policy.CodeSenderNotAllowed, "alphanumeric sender longer than %d characters", maxAlnum)
	}
	if !hasLetter {
		return Sender{}, policy.Errorf(policy.CodeSenderNotAllowed, "invalid sender %q", in)
	}
	return Sender{TON: TONAlphanumeric, NPI: NPIUnknown, Normalized: s}, nil
}

func allDigits(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// Country returns the ISO 3166-1 alpha-2 code for a normalized MSISDN (digits
// only) by longest-prefix match over the ITU-T E.164 assignments, plus the
// matched calling-code prefix. NANP (+1) numbers are resolved by area code
// (US default). Non-geographic codes (+800, +870, +881, +882, +883, +888,
// +979, ...) return ok=false.
func Country(msisdn string) (iso2, prefix string, ok bool) {
	n := len(msisdn)
	if n > maxPrefixLen {
		n = maxPrefixLen
	}
	for l := n; l >= 1; l-- {
		p := msisdn[:l]
		if c, found := countryPrefixes[p]; found {
			if c == "" {
				return "", p, false
			}
			return c, p, true
		}
	}
	return "", "", false
}

// CountryCode is Country returning only the ISO code ("" when unknown).
func CountryCode(msisdn string) string {
	c, _, _ := Country(msisdn)
	return c
}

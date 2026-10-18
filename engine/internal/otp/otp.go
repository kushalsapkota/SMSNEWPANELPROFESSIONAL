// Package otp extracts one-time passwords from message text and renders
// route templates (CONTRACTS §9 step 6).
//
// # Extraction semantics
//
// Patterns are RE2 (Go regexp) and are tried in order. For each pattern,
// EVERY non-overlapping match is examined left to right; the first match
// whose OTP length lies within [minLen, maxLen] wins. The OTP of a match is
// the first non-empty capturing group when the pattern has groups,
// otherwise the whole match. That lets keyword-anchored patterns such as
// `(?i)\botp\b[^0-9]{0,20}([0-9]{4,8})\b` return just the digits.
//
// Length is measured in Unicode code points.
//
// Default patterns (DefaultPatterns, mirrored by migration 005) are ordered
// from most to least specific so amounts, years and reference numbers that
// appear before the code are skipped:
//
//  1. keyword then code:        "OTP is 4821", "Code: 5521", "Pay Rs 2500 ... OTP 772211"
//  2. code then "is your <kw>":  "849201 is your code", "G-123456 is your Google verification code"
//  3. keyword ... is/: code:     "OTP for login on 2024-05-01 is 5521", "code for Rs 2500 is 772211"
//  4. keyword, words, code:      "Code for Acme 5521"
//  5. any 4–8 digit number:      "use 1234 to login. Do not share. Ref 99"
//  6. mixed alnum token:         "Code: AB12CD" (needs ≥1 letter and ≥1 digit)
//
// Known limitation: a message with no keyword and several 4–8 digit numbers
// (e.g. "a/c 1234 debited, call 18001234") yields the first number. Such
// non-OTP traffic should not be sent on template-mode routes.
package otp

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"unicode/utf8"
)

// Action is the template outcome. Values match the DB enum template_fallback
// plus TEMPLATED.
type Action string

const (
	ActionTemplated           Action = "TEMPLATED"
	ActionSendRaw             Action = "SEND_RAW"
	ActionReject              Action = "REJECT"
	ActionSendDefaultTemplate Action = "SEND_DEFAULT_TEMPLATE"
)

// ValidFallback reports whether a is a legal fallback action.
func ValidFallback(a Action) bool {
	return a == ActionSendRaw || a == ActionReject || a == ActionSendDefaultTemplate
}

// DefaultPatterns are the recommended extract_patterns (see package doc),
// most specific first. Keep in sync with db/migrations/005_otp_patterns.sql.
var DefaultPatterns = []string{
	// 1. keyword immediately followed by the code: "OTP is 4821", "Code: 5521", "PIN - 0042"
	`(?i)\b(?:otp|code|pin|passcode|password|passwd|token)\b(?:\s*(?:is|:|=|-|#))*\s*([0-9]{4,8})\b`,
	// 2. code, then "is your/the ... <keyword>": "849201 is your code", "G-123456 is your Google verification code"
	`(?i)\b([0-9]{4,8})\b\s*(?:is|=|:|-)?\s*(?:your|the|ur)\b[^0-9\n]{0,40}?\b(?:otp|code|pin|passcode|password|token)\b`,
	// 3. keyword ... "is"/":" code, skipping dates/amounts in between: "OTP for login on 2024-05-01 is 5521"
	`(?i)\b(?:otp|code|pin|passcode|password|passwd|token)\b.{0,60}?(?:\bis\b|:)\s*:?\s*([0-9]{4,8})\b`,
	// 4. keyword, a few words, then the code: "Code for Acme 5521"
	`(?i)\b(?:otp|code|pin|passcode|password|passwd|token)\b[^0-9\n]{0,20}?\b([0-9]{4,8})\b`,
	// 5. any standalone 4-8 digit number: "use 1234 to login"
	`\b[0-9]{4,8}\b`,
	// 6. mixed alphanumeric token with at least one letter and one digit: "AB12CD"
	`\b[A-Za-z0-9]*(?:[A-Za-z][0-9]|[0-9][A-Za-z])[A-Za-z0-9]*\b`,
}

// Default length bounds (DB defaults).
const (
	DefaultMinLen = 4
	DefaultMaxLen = 8
)

// PatternError reports an invalid regular expression.
type PatternError struct {
	Index   int
	Pattern string
	Err     error
}

func (e *PatternError) Error() string {
	return fmt.Sprintf("otp: invalid pattern #%d %q: %v", e.Index, e.Pattern, e.Err)
}

func (e *PatternError) Unwrap() error { return e.Err }

// ErrNoPatterns is returned when Extract is given no patterns.
var ErrNoPatterns = errors.New("otp: no extract patterns")

// maxCacheEntries bounds the compiled-regex cache; on overflow it is reset.
const maxCacheEntries = 4096

type cacheEntry struct {
	re  *regexp.Regexp
	err error
}

var (
	cacheMu sync.RWMutex
	cache   = make(map[string]cacheEntry)
)

// Compile returns a cached compiled regexp for pattern. Compilation errors
// are cached too, so a bad template costs one compile per process.
// *regexp.Regexp is safe for concurrent use.
func Compile(pattern string) (*regexp.Regexp, error) {
	cacheMu.RLock()
	e, ok := cache[pattern]
	cacheMu.RUnlock()
	if ok {
		return e.re, e.err
	}
	re, err := regexp.Compile(pattern)
	cacheMu.Lock()
	if len(cache) >= maxCacheEntries {
		clear(cache)
	}
	cache[pattern] = cacheEntry{re: re, err: err}
	cacheMu.Unlock()
	return re, err
}

// ValidatePatterns compiles every pattern and returns the first error as a
// *PatternError.
func ValidatePatterns(patterns []string) error {
	if len(patterns) == 0 {
		return ErrNoPatterns
	}
	for i, p := range patterns {
		if _, err := Compile(p); err != nil {
			return &PatternError{Index: i, Pattern: p, Err: err}
		}
	}
	return nil
}

// Match is a successful extraction.
type Match struct {
	OTP          string
	Pattern      string // the pattern that matched
	PatternIndex int
}

// Extract finds the OTP in text (see package doc). It returns
// (otp, matchedPattern, true) on success. If any pattern is invalid it
// returns a *PatternError — invalid patterns never panic and are reported
// even if a later pattern would have matched, so misconfiguration surfaces.
// minLen<=0 and maxLen<=0 select the defaults.
func Extract(patterns []string, minLen, maxLen int, text string) (otp string, matchedPattern string, ok bool, err error) {
	m, ok, err := ExtractMatch(patterns, minLen, maxLen, text)
	return m.OTP, m.Pattern, ok, err
}

// ExtractMatch is Extract returning a Match.
func ExtractMatch(patterns []string, minLen, maxLen int, text string) (Match, bool, error) {
	if len(patterns) == 0 {
		return Match{}, false, ErrNoPatterns
	}
	if minLen <= 0 {
		minLen = DefaultMinLen
	}
	if maxLen <= 0 {
		maxLen = DefaultMaxLen
	}
	if maxLen < minLen {
		return Match{}, false, fmt.Errorf("otp: max length %d < min length %d", maxLen, minLen)
	}
	res := make([]*regexp.Regexp, len(patterns))
	for i, p := range patterns {
		re, err := Compile(p)
		if err != nil {
			return Match{}, false, &PatternError{Index: i, Pattern: p, Err: err}
		}
		res[i] = re
	}
	for i, re := range res {
		groups := re.NumSubexp() > 0
		for _, sm := range re.FindAllStringSubmatch(text, -1) {
			cand := sm[0]
			if groups {
				cand = ""
				for _, g := range sm[1:] {
					if g != "" {
						cand = g
						break
					}
				}
			}
			if cand == "" {
				continue
			}
			if n := utf8.RuneCountInString(cand); n >= minLen && n <= maxLen {
				return Match{OTP: cand, Pattern: patterns[i], PatternIndex: i}, true, nil
			}
		}
	}
	return Match{}, false, nil
}

// Vars are the template placeholders other than {otp}.
type Vars struct {
	Brand  string
	Sender string
}

// Render replaces {otp}, {brand} and {sender} in body in a single pass, so
// substituted values are never re-expanded (an OTP of "{brand}" stays
// literal).
func Render(body, otp string, v Vars) string {
	return strings.NewReplacer("{otp}", otp, "{brand}", v.Brand, "{sender}", v.Sender).Replace(body)
}

// Template is the subset of route_templates needed to resolve a message.
type Template struct {
	Patterns    []string
	MinLen      int
	MaxLen      int
	Body        string  // template_body (contains {otp})
	DefaultBody *string // default_body (SEND_DEFAULT_TEMPLATE)
	// Fallback is the template's fallback_action; "" inherits the route's.
	Fallback Action
	// Brand overrides Vars.Brand when non-empty.
	Brand string
}

// Result of Resolve.
type Result struct {
	Action         Action
	Output         string // final text; "" when Action == REJECT
	OTP            string // "" when no OTP was extracted
	MatchedPattern string
}

// Resolve applies a route template to text.
//
//   - tpl == nil (template_mode route without any active template): SEND_RAW.
//   - OTP found: TEMPLATED, Output = Render(tpl.Body).
//   - No OTP: fallback = tpl.Fallback, else routeFallback, else SEND_RAW:
//     REJECT → Output ""; SEND_RAW → original text;
//     SEND_DEFAULT_TEMPLATE → Render(*tpl.DefaultBody) with {otp} = ""
//     (falls back to SEND_RAW when the template has no default_body).
//
// vars.Brand should already be the org chain brand (client → reseller);
// tpl.Brand takes precedence. Invalid patterns return a *PatternError and a
// zero Result; callers should treat that as a configuration error.
func Resolve(tpl *Template, routeFallback Action, text string, vars Vars) (Result, error) {
	if tpl == nil {
		return Result{Action: ActionSendRaw, Output: text}, nil
	}
	if tpl.Brand != "" {
		vars.Brand = tpl.Brand
	}
	m, ok, err := ExtractMatch(tpl.Patterns, tpl.MinLen, tpl.MaxLen, text)
	if err != nil {
		return Result{}, err
	}
	if ok {
		return Result{
			Action:         ActionTemplated,
			Output:         Render(tpl.Body, m.OTP, vars),
			OTP:            m.OTP,
			MatchedPattern: m.Pattern,
		}, nil
	}
	fb := tpl.Fallback
	if fb == "" {
		fb = routeFallback
	}
	switch fb {
	case ActionReject:
		return Result{Action: ActionReject}, nil
	case ActionSendDefaultTemplate:
		if tpl.DefaultBody != nil {
			return Result{Action: ActionSendDefaultTemplate, Output: Render(*tpl.DefaultBody, "", vars)}, nil
		}
		return Result{Action: ActionSendRaw, Output: text}, nil
	default:
		return Result{Action: ActionSendRaw, Output: text}, nil
	}
}

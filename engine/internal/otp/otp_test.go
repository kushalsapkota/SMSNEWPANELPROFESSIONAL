package otp

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
)

// Real-world OTP messages and what DefaultPatterns must extract. The second
// column documents expected behaviour; "" means no OTP should be found.
var realWorld = []struct {
	text string
	want string
	why  string
}{
	{"Your OTP is 4821", "4821", "keyword + is"},
	{"G-123456 is your Google verification code.", "123456", "code before 'is your ... code'"},
	{"849201 is your code", "849201", "code before keyword"},
	{"Code: AB12CD", "AB12CD", "alphanumeric fallback"},
	{"use 1234 to login. Do not share. Ref 99", "1234", "generic digits; 99 too short"},
	{"Pay Rs 2500 to merchant XYZ. OTP 772211. Do not share.", "772211", "amount before keyword is skipped"},
	{"Rs 2500 debited from a/c XX1234. OTP 998877", "998877", "amount + masked account before keyword"},
	{"Your OTP for login on 2024-05-01 is 5521", "5521", "date between keyword and code"},
	{"Your verification code for amount Rs 2500 is 772211", "772211", "amount between keyword and 'is'"},
	{"Dear user, 4567 is the OTP for your transaction of INR 15000", "4567", "code first, amount after"},
	{"Use verification code 5521 for txn of Rs 2,500 on 12/05/2024", "5521", "keyword adjacent"},
	{"Your one time password is 8812. Valid for 10 mins.", "8812", "password keyword"},
	{"Your PIN is 0042", "0042", "leading zeros kept"},
	{"Ref 99887766 - your code is 1234", "1234", "reference number before keyword"},
	{"Your code is AB12CD", "AB12CD", "alnum after keyword"},
	{"2024 Annual offer! Your code is 7788", "7788", "year before keyword"},
	{"[Acme] Your login code: 908172. It expires in 10 minutes.", "908172", "brackets, colon"},
	{"WhatsApp code 123-456? no: 554433 is your WhatsApp code", "554433", "code-first phrase wins over split"},
	{"Your Uber code: 7777. Never share this code.", "7777", "repeated keyword"},
	{"OTP:12345678", "12345678", "no space, 8 digits"},
	{"otp is 123456789 (invalid) code 4455", "4455", "9-digit run skipped; later keyword match"},
	{"Ihr Bestätigungscode lautet 3344", "3344", "non-English: generic digits"},
	{"Hello world, see you soon", "", "plain words are never an OTP"},
	{"Meeting at 10:30 in room 12", "", "short numbers only"},
	{"Your token #A1B2C3 has been issued", "A1B2C3", "alnum token"},
	{"Code for Acme 5521", "5521", "keyword, words, code"},
	{"Your 2FA code\n481516\nDo not share", "481516", "newline separated"},
}

func TestExtractRealWorld(t *testing.T) {
	for _, c := range realWorld {
		got, pat, ok, err := Extract(DefaultPatterns, 4, 8, c.text)
		if err != nil {
			t.Fatalf("%q: %v", c.text, err)
		}
		if c.want == "" {
			if ok {
				t.Errorf("%q (%s): expected no OTP, got %q via %s", c.text, c.why, got, pat)
			}
			continue
		}
		if !ok || got != c.want {
			t.Errorf("%q (%s): got %q (ok=%v) via %q, want %q", c.text, c.why, got, ok, pat, c.want)
		}
	}
}

// The old 001_init.sql defaults pick the amount; documents why 005 exists.
func TestOldDefaultsPickAmount(t *testing.T) {
	old := []string{`\b[0-9]{4,8}\b`, `\b[A-Za-z0-9]*(?:[A-Za-z][0-9]|[0-9][A-Za-z])[A-Za-z0-9]*\b`}
	got, _, _, _ := Extract(old, 4, 8, "Pay Rs 2500 to merchant XYZ. OTP 772211.")
	if got != "2500" {
		t.Fatalf("expected the legacy defaults to (wrongly) pick 2500, got %q", got)
	}
}

func TestExtractEveryMatchLengthBounds(t *testing.T) {
	p := []string{`\b[0-9]+\b`}
	cases := []struct {
		text     string
		min, max int
		want     string
	}{
		{"Ref 12, order 123, code 567890", 6, 6, "567890"},
		{"1 22 333 4444 55555", 5, 8, "55555"},
		{"1 22 333", 4, 8, ""},
		{"123456789 then 1234", 4, 8, "1234"},
	}
	for _, c := range cases {
		got, _, ok, err := Extract(p, c.min, c.max, c.text)
		if err != nil {
			t.Fatal(err)
		}
		if (c.want == "") == ok || got != c.want {
			t.Errorf("%q [%d,%d]: got %q ok=%v want %q", c.text, c.min, c.max, got, ok, c.want)
		}
	}
}

func TestExtractPatternOrderAndGroups(t *testing.T) {
	// Pattern 0 has no match within bounds; pattern 1 is used.
	pats := []string{`code (\d+)`, `\b[A-Z]{3}\b`}
	got, pat, ok, _ := Extract(pats, 4, 8, "code 12 is ABC")
	if ok {
		t.Fatalf("ABC is 3 chars, expected no match, got %q via %s", got, pat)
	}
	got, pat, ok, _ = Extract(pats, 3, 8, "code 12 is ABC")
	if !ok || got != "ABC" || pat != pats[1] {
		t.Fatalf("got %q via %q", got, pat)
	}
	// Alternation: first non-empty group wins.
	alt := []string{`(?:pin (\d{4})|otp (\d{6}))`}
	got, _, ok, _ = Extract(alt, 4, 8, "your otp 123456")
	if !ok || got != "123456" {
		t.Fatalf("alternation group: %q", got)
	}
	// Rune-length, not byte-length.
	got, _, ok, _ = Extract([]string{`[٠-٩]+`}, 4, 4, "رمز ٤٥٦٧")
	if !ok || got != "٤٥٦٧" {
		t.Fatalf("unicode length: %q %v", got, ok)
	}
}

func TestExtractInvalidPattern(t *testing.T) {
	_, _, ok, err := Extract([]string{`\d{4}`, `(?<=x)\d+`}, 4, 8, "1234")
	var pe *PatternError
	if !errors.As(err, &pe) || pe.Index != 1 || ok {
		t.Fatalf("expected PatternError index 1, got %v ok=%v", err, ok)
	}
	// Cached error is returned again, still no panic.
	if _, _, _, err := Extract([]string{`(?<=x)\d+`}, 4, 8, "1234"); err == nil {
		t.Fatal("cached invalid pattern returned no error")
	}
	if err := ValidatePatterns([]string{`ok`, `[`}); err == nil {
		t.Fatal("ValidatePatterns accepted [")
	}
	if err := ValidatePatterns(DefaultPatterns); err != nil {
		t.Fatalf("defaults invalid: %v", err)
	}
	if _, _, _, err := Extract(nil, 4, 8, "x"); !errors.Is(err, ErrNoPatterns) {
		t.Fatalf("nil patterns: %v", err)
	}
	if _, _, _, err := Extract([]string{`x`}, 8, 4, "x"); err == nil {
		t.Fatal("max<min accepted")
	}
}

func TestRender(t *testing.T) {
	got := Render("{brand}: {otp} is your code. From {sender}. {otp}", "1234", Vars{Brand: "Acme", Sender: "ACME"})
	if got != "Acme: 1234 is your code. From ACME. 1234" {
		t.Fatal(got)
	}
	// No recursive expansion.
	if got := Render("{otp}", "{brand}", Vars{Brand: "X"}); got != "{brand}" {
		t.Fatalf("recursive expansion: %q", got)
	}
	if got := Render("{unknown} {otp}", "1", Vars{}); got != "{unknown} 1" {
		t.Fatal(got)
	}
}

func TestResolve(t *testing.T) {
	def := "{brand} code unavailable, contact {sender}"
	base := Template{Patterns: DefaultPatterns, MinLen: 4, MaxLen: 8, Body: "{brand}: your code is {otp}", DefaultBody: &def}
	withFB := func(a Action) *Template { t := base; t.Fallback = a; return &t }
	noDefault := base
	noDefault.DefaultBody = nil
	noDefault.Fallback = ActionSendDefaultTemplate
	branded := base
	branded.Brand = "TplBrand"
	vars := Vars{Brand: "Client", Sender: "ACME"}

	cases := []struct {
		name    string
		tpl     *Template
		routeFB Action
		text    string
		action  Action
		output  string
		otp     string
	}{
		{"templated", &base, ActionReject, "Your OTP is 4821", ActionTemplated, "Client: your code is 4821", "4821"},
		{"template brand overrides", &branded, ActionSendRaw, "849201 is your code", ActionTemplated, "TplBrand: your code is 849201", "849201"},
		{"route fallback reject", &base, ActionReject, "hello there", ActionReject, "", ""},
		{"route fallback raw", &base, ActionSendRaw, "hello there", ActionSendRaw, "hello there", ""},
		{"route fallback default", &base, ActionSendDefaultTemplate, "hello there", ActionSendDefaultTemplate, "Client code unavailable, contact ACME", ""},
		{"template fallback beats route", withFB(ActionSendRaw), ActionReject, "hello there", ActionSendRaw, "hello there", ""},
		{"template reject beats route raw", withFB(ActionReject), ActionSendRaw, "hello there", ActionReject, "", ""},
		{"default without body -> raw", &noDefault, ActionReject, "hello there", ActionSendRaw, "hello there", ""},
		{"empty fallbacks -> raw", &base, "", "hello there", ActionSendRaw, "hello there", ""},
		{"nil template -> raw", nil, ActionReject, "Your OTP is 4821", ActionSendRaw, "Your OTP is 4821", ""},
	}
	for _, c := range cases {
		r, err := Resolve(c.tpl, c.routeFB, c.text, vars)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if r.Action != c.action || r.Output != c.output || r.OTP != c.otp {
			t.Errorf("%s: got %+v", c.name, r)
		}
		if r.Action == ActionTemplated && r.MatchedPattern == "" {
			t.Errorf("%s: matched pattern missing", c.name)
		}
	}
	bad := base
	bad.Patterns = []string{`(`}
	if _, err := Resolve(&bad, ActionSendRaw, "1234", vars); err == nil {
		t.Fatal("invalid pattern not reported")
	}
}

func TestCompileCacheConcurrentAndBounded(t *testing.T) {
	var wg sync.WaitGroup
	for g := 0; g < 16; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < 600; i++ {
				re, err := Compile(fmt.Sprintf(`x%d_%d`, g, i))
				if err != nil || re == nil {
					t.Errorf("compile: %v", err)
					return
				}
			}
		}(g)
	}
	wg.Wait()
	cacheMu.RLock()
	n := len(cache)
	cacheMu.RUnlock()
	if n > maxCacheEntries {
		t.Fatalf("cache unbounded: %d", n)
	}
}

func TestDefaultsMatchMigration(t *testing.T) {
	// The migration stores the same patterns as a SQL array; make sure each
	// one is present verbatim (it lives two directories up).
	b, err := readMigration()
	if err != nil {
		t.Skipf("migration not readable: %v", err)
	}
	for _, p := range DefaultPatterns {
		if !strings.Contains(b, "'"+strings.ReplaceAll(p, "'", "''")+"'") {
			t.Errorf("pattern missing from 005_otp_patterns.sql: %s", p)
		}
	}
}

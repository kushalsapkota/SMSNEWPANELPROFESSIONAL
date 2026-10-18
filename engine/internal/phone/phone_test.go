package phone

import (
	"testing"

	"smsgw/engine/internal/policy"
)

func TestNormalizeMSISDN(t *testing.T) {
	ok := map[string]string{
		"+91 98765 43210":    "919876543210",
		"919876543210":       "919876543210",
		"+1-555-123-4567":    "15551234567",
		"+1 (555) 123.4567":  "15551234567",
		"  +44 7700 900123 ": "447700900123",
		"123456":             "123456",
		"123456789012345":    "123456789012345",
		"+49 151\t2345":      "491512345",
	}
	for in, want := range ok {
		got, err := NormalizeMSISDN(in)
		if err != nil || got != want {
			t.Errorf("%q: got %q %v want %q", in, got, err, want)
		}
	}
	bad := []string{"", "12345", "1234567890123456", "+91 98x65", "++919876543210", "91+9876543210", "abc", "+", "٩١٩٨٧٦٥٤٣٢١٠"}
	for _, in := range bad {
		_, err := NormalizeMSISDN(in)
		if policy.CodeOf(err) != policy.CodeInvalidDestination {
			t.Errorf("%q: expected INVALID_DESTINATION, got %v", in, err)
		}
	}
}

func TestClassifySender(t *testing.T) {
	cases := []struct {
		in       string
		ton, npi uint8
		norm     string
	}{
		{"MYBANK", 5, 0, "MYBANK"},
		{"Acme Corp", 5, 0, "Acme Corp"},
		{"INFO-1", 5, 0, "INFO-1"},
		{"ABCDEFGHIJK", 5, 0, "ABCDEFGHIJK"},
		{"919876543210", 1, 1, "919876543210"},
		{"+919876543210", 1, 1, "919876543210"},
		{"123456789", 1, 1, "123456789"},
		{"12345678", 3, 0, "12345678"},
		{"+12345", 3, 0, "12345"},
		{"5555", 3, 0, "5555"},
		{" 56789 ", 3, 0, "56789"},
	}
	for _, c := range cases {
		s, err := ClassifySender(c.in)
		if err != nil || s.TON != c.ton || s.NPI != c.npi || s.Normalized != c.norm {
			t.Errorf("%q: got %+v %v", c.in, s, err)
		}
	}
	for _, in := range []string{"", "ABCDEFGHIJKL", "1234567890123456", "+ABC", "12-34", "Bänk", "a\tb"} {
		if _, err := ClassifySender(in); policy.CodeOf(err) != policy.CodeSenderNotAllowed {
			t.Errorf("%q: expected SENDER_NOT_ALLOWED, got %v", in, err)
		}
	}
}

func TestCountry(t *testing.T) {
	cases := map[string]string{
		"919876543210":  "IN",
		"447700900123":  "JE", // 447700 is a Jersey mobile range
		"447911123456":  "GG",
		"447400123456":  "GB",
		"441624123456":  "IM",
		"14165551234":   "CA",
		"12125551234":   "US",
		"18095551234":   "DO",
		"18765551234":   "JM",
		"17875551234":   "PR",
		"12425551234":   "BS",
		"79161234567":   "RU",
		"77011234567":   "KZ",
		"76123456789":   "KZ",
		"390669812345":  "VA",
		"393331234567":  "IT",
		"358181234567":  "AX",
		"358401234567":  "FI",
		"971501234567":  "AE",
		"8613812345678": "CN",
		"85291234567":   "HK",
		"5511912345678": "BR",
		"2348031234567": "NG",
		"262269123456":  "YT",
		"262692123456":  "RE",
		"59971234567":   "BQ",
		"59991234567":   "CW",
		"4791234567":    "NO",
		"4779123456":    "SJ",
		"6723123456":    "NF",
		"38344123456":   "XK",
		"2971234567":    "AW",
		"6421234567":    "NZ",
		"61412345678":   "AU",
		"6189164123":    "CX",
		"201001234567":  "EG",
		"27821234567":   "ZA",
		"9647701234567": "IQ",
		"998901234567":  "UZ",
		"5016221234":    "BZ",
		"2126612345678": "MA",
		"88612345678":   "TW",
		"9779812345678": "NP",
		"6591234567":    "SG",
		"3530871234567": "IE",
		"4915123456789": "DE",
		"33612345678":   "FR",
		"34612345678":   "ES",
		"3197012345678": "NL",
		"923001234567":  "PK",
		"8801712345678": "BD",
		"94771234567":   "LK",
		"9607712345":    "MV",
		"6281234567890": "ID",
		"639171234567":  "PH",
		"60123456789":   "MY",
		"66812345678":   "TH",
		"84912345678":   "VN",
		"819012345678":  "JP",
		"821012345678":  "KR",
		"905321234567":  "TR",
		"966501234567":  "SA",
		"2547123456789": "KE",
		"233241234567":  "GH",
		"523312345678":  "MX",
		"5491112345678": "AR",
		"56912345678":   "CL",
		"573001234567":  "CO",
		"51912345678":   "PE",
		"584121234567":  "VE",
		"380501234567":  "UA",
		"48501234567":   "PL",
		"420601123456":  "CZ",
		"40721234567":   "RO",
		"36201234567":   "HU",
		"306912345678":  "GR",
		"351912345678":  "PT",
		"41791234567":   "CH",
		"436641234567":  "AT",
		"32470123456":   "BE",
		"4520123456":    "DK",
		"46701234567":   "SE",
		"972501234567":  "IL",
		"970591234567":  "PS",
	}
	for in, want := range cases {
		got, _, ok := Country(in)
		if !ok || got != want {
			t.Errorf("%s: got %q (%v) want %s", in, got, ok, want)
		}
	}
	for _, in := range []string{"80012345678", "88213456789", "870123456789", "979123456", "0123456", ""} {
		if c, _, ok := Country(in); ok {
			t.Errorf("%s: expected no country, got %s", in, c)
		}
	}
	if _, p, _ := Country("447911123456"); p != "447911" {
		t.Errorf("prefix: %s", p)
	}
}

// Every single-digit-led zone must resolve something for every 3-digit
// prefix except unassigned/spare codes; this guards against typos that
// silently drop a country.
func TestTableCoversAllAssignedCodes(t *testing.T) {
	spare := map[string]bool{
		"210": true, "214": true, "215": true, "217": true, "219": true, "259": true,
		"280": true, "281": true, "282": true, "283": true, "284": true, "285": true, "286": true, "287": true, "288": true, "289": true,
		"292": true, "293": true, "294": true, "295": true, "296": true,
		"384": true, "388": true, "422": true, "424": true, "425": true, "426": true, "427": true, "428": true, "429": true,
		"671": true, "684": true, "693": true, "694": true, "695": true, "696": true, "697": true, "698": true, "699": true,
		"801": true, "802": true, "803": true, "804": true, "805": true, "806": true, "807": true, "809": true,
		"830": true, "831": true, "832": true, "833": true, "834": true, "835": true, "836": true, "837": true, "838": true, "839": true,
		"851": true, "854": true, "857": true, "858": true, "859": true,
		"871": true, "872": true, "873": true, "874": true, "875": true, "876": true, "877": true, "879": true,
		"884": true, "885": true, "887": true, "889": true,
		"890": true, "891": true, "892": true, "893": true, "894": true, "895": true, "896": true, "897": true, "898": true, "899": true,
		"969": true, "978": true, "990": true, "997": true, "999": true,
	}
	for _, zone := range []byte("2356789") {
		for a := byte('0'); a <= '9'; a++ {
			for b := byte('0'); b <= '9'; b++ {
				p := string([]byte{zone, a, b})
				if spare[p] {
					continue
				}
				if _, mp, _ := Country(p + "1234567"); mp == "" {
					t.Errorf("no entry covering %s", p)
				}
			}
		}
	}
}

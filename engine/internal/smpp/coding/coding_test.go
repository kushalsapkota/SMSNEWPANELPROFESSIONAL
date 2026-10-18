package coding

import (
	"bytes"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestDetect(t *testing.T) {
	cases := map[string]Encoding{
		"":                   GSM7,
		"Hello world @£$¥":   GSM7,
		"€ ^ { } [ ] ~ | \\": GSM7,
		"\f":                 GSM7,
		"Привет":             UCS2,
		"Hi 😀":               UCS2,
		"ç":                  UCS2, // only capital Ç is in 03.38
		"`":                  UCS2,
		"\x1b":               UCS2, // raw ESC isn't a character
		"ΔΦΓΛΩΠΨΣΘΞ ÄÖÑÜ§¿äöñüà¡": GSM7,
	}
	for in, want := range cases {
		if got := Detect(in); got != want {
			t.Errorf("Detect(%q) = %v want %v", in, got, want)
		}
	}
}

func TestSeptetCount(t *testing.T) {
	n, ok := SeptetCount("€^{}[]~|\\")
	if !ok || n != 18 {
		t.Fatal(n, ok)
	}
	n, _ = SeptetCount("abc€")
	if n != 5 {
		t.Fatal(n)
	}
	if UTF16Len("a😀") != 3 {
		t.Fatal(UTF16Len("a😀"))
	}
}

func TestAnalyzeBoundaries(t *testing.T) {
	cases := []struct {
		text  string
		enc   Encoding
		units int
		parts int
	}{
		{strings.Repeat("a", 160), GSM7, 160, 1},
		{strings.Repeat("a", 161), GSM7, 161, 2},
		{strings.Repeat("a", 306), GSM7, 306, 2},
		{strings.Repeat("a", 307), GSM7, 307, 3},
		{strings.Repeat("€", 80), GSM7, 160, 1},
		{strings.Repeat("€", 81), GSM7, 162, 2},
		{strings.Repeat("ж", 70), UCS2, 70, 1},
		{strings.Repeat("ж", 71), UCS2, 71, 2},
		{strings.Repeat("😀", 35), UCS2, 70, 1},
		{strings.Repeat("😀", 36), UCS2, 72, 2},
		{strings.Repeat("a", 1530), GSM7, 1530, 10},
		{strings.Repeat("a", 1531), GSM7, 1531, 11},
	}
	for _, c := range cases {
		i := Analyze(c.text)
		if i.Encoding != c.enc || i.Units != c.units || i.Parts != c.parts {
			t.Errorf("Analyze(%d x %q) = %+v", utf8.RuneCountInString(c.text), []rune(c.text)[0], i)
		}
		if (i.Parts > MaxParts) != i.TooLong() {
			t.Error("TooLong")
		}
	}
}

func TestSplitGSMNeverSplitsEscape(t *testing.T) {
	// 152 'a' then '€': '€' (2 septets) would straddle the 153 boundary.
	text := strings.Repeat("a", 152) + "€" + strings.Repeat("b", 10)
	segs, err := Split(text, GSM7)
	if err != nil {
		t.Fatal(err)
	}
	if len(segs) != 2 {
		t.Fatalf("got %d segments", len(segs))
	}
	if segs[0] != strings.Repeat("a", 152) || !strings.HasPrefix(segs[1], "€") {
		t.Fatalf("escape pair split: %q | %q", segs[0], segs[1])
	}
	if strings.Join(segs, "") != text {
		t.Fatal("lossy split")
	}
	for _, s := range segs {
		if n, _ := SeptetCount(s); n > GSM7PartMax {
			t.Fatalf("segment too long: %d", n)
		}
		enc, _ := EncodeGSM7(s)
		if len(enc) > GSM7PartMax {
			t.Fatal("encoded segment too long")
		}
	}
}

func TestSplitUCS2NeverSplitsSurrogate(t *testing.T) {
	text := strings.Repeat("ж", 66) + "😀" + strings.Repeat("ж", 10)
	segs, err := Split(text, UCS2)
	if err != nil {
		t.Fatal(err)
	}
	if len(segs) != 2 || segs[0] != strings.Repeat("ж", 66) || !strings.HasPrefix(segs[1], "😀") {
		t.Fatalf("%q", segs)
	}
	for _, s := range segs {
		if UTF16Len(s) > UCS2PartMax || len(EncodeUCS2(s)) > 2*UCS2PartMax {
			t.Fatal("segment too long")
		}
		if !utf8.ValidString(s) {
			t.Fatal("invalid utf8 in segment")
		}
	}
	// All emoji: each segment holds 33 emoji (66 units).
	segs, _ = Split(strings.Repeat("😀", 40), UCS2)
	if len(segs) != 2 || UTF16Len(segs[0]) != 66 {
		t.Fatalf("%d %d", len(segs), UTF16Len(segs[0]))
	}
}

func TestSplitSingleAndErrors(t *testing.T) {
	segs, _ := Split("hello", GSM7)
	if len(segs) != 1 || segs[0] != "hello" {
		t.Fatal(segs)
	}
	segs, _ = Split("", GSM7)
	if len(segs) != 1 || segs[0] != "" {
		t.Fatal(segs)
	}
	if _, err := Split("Привет", GSM7); err != ErrNotGSM {
		t.Fatal(err)
	}
	segs, _ = Split(strings.Repeat("x", 459), GSM7)
	if len(segs) != 3 || len(segs[2]) != 153 {
		t.Fatal(len(segs))
	}
}

func TestEncodeDecodeGSM(t *testing.T) {
	all := []rune{}
	for i, r := range gsmBasic {
		if i != esc {
			all = append(all, r)
		}
	}
	text := string(all) + "€^{}[]~|\\\f"
	b, err := EncodeGSM7(text)
	if err != nil {
		t.Fatal(err)
	}
	if len(b) != 127+20 {
		t.Fatal(len(b))
	}
	if got := DecodeGSM7(b); got != text {
		t.Fatalf("round trip\n got %q\nwant %q", got, text)
	}
	if got := Decode(0, b); got != text {
		t.Fatal("Decode(0)")
	}
	b, _ = EncodeGSM7("@€")
	if !bytes.Equal(b, []byte{0x00, 0x1B, 0x65}) {
		t.Fatalf("% x", b)
	}
	if _, err := EncodeGSM7("ж"); err == nil {
		t.Fatal("expected error")
	}
	// lone trailing escape, unknown ext code
	if DecodeGSM7([]byte{'A' - 0x00, 0x1B}) != "A" {
		t.Fatal("trailing esc")
	}
	if DecodeGSM7([]byte{0x1B, 0x41}) != "A" {
		t.Fatal("unknown ext fallback")
	}
}

func TestEncodeDecodeUCS2(t *testing.T) {
	text := "Привет 😀 €"
	b := EncodeUCS2(text)
	if len(b) != 2*UTF16Len(text) {
		t.Fatal(len(b))
	}
	if Decode(8, b) != text {
		t.Fatal(Decode(8, b))
	}
	if DecodeUCS2(append(b, 0x41)) != text {
		t.Fatal("odd byte")
	}
	if !bytes.Equal(EncodeUCS2("A"), []byte{0, 'A'}) {
		t.Fatal("BE")
	}
}

func TestDecodeOthers(t *testing.T) {
	if Decode(1, []byte("plain ascii @")) != "plain ascii @" {
		t.Fatal("ia5")
	}
	if Decode(3, []byte{'c', 'a', 'f', 0xE9}) != "café" {
		t.Fatal("latin1")
	}
	if Decode(6, []byte{0xBF, 0xE0, 0xD8, 0xD2, 0xD5, 0xE2}) != "Привет" {
		t.Fatal(Decode(6, []byte{0xBF, 0xE0, 0xD8, 0xD2, 0xD5, 0xE2}))
	}
	if Decode(7, []byte{0xF9, 0xEC, 0xE5, 0xED}) != "שלום" {
		t.Fatal("hebrew")
	}
	if Decode(0, []byte("caf\xc3\xa9")) != "café" {
		t.Fatal("utf8 in dc0")
	}
	if Decode(0, []byte{'a', 0xE9}) != "aé" {
		t.Fatal("latin1 in dc0")
	}
	if Decode(4, []byte{0xff, 0x00}) != "ÿ\x00" {
		t.Fatal("binary")
	}
	if Decode(0x18, EncodeUCS2("ж")) != "ж" || Decode(0xF0, []byte{0x00}) != "@" || Decode(0xE0, EncodeUCS2("ж")) != "ж" {
		t.Fatal("dcs groups")
	}
}

func TestUDH(t *testing.T) {
	sm := append(ConcatUDH8(0xAB, 3, 2), []byte("data")...)
	c, payload, ok, err := ParseConcat(sm)
	if err != nil || !ok || c.Ref != 0xAB || c.Total != 3 || c.Seq != 2 || c.Ref16 || string(payload) != "data" {
		t.Fatal(c, payload, ok, err)
	}
	sm = append(ConcatUDH16(0xBEEF, 4, 4), []byte("x")...)
	c, payload, ok, err = ParseConcat(sm)
	if err != nil || !ok || c.Ref != 0xBEEF || c.Total != 4 || c.Seq != 4 || !c.Ref16 || string(payload) != "x" {
		t.Fatal(c, payload, ok, err)
	}
	// UDH with a port IE before the concat IE
	sm = []byte{0x0B, 0x05, 0x04, 0x0B, 0x84, 0x23, 0xF0, 0x00, 0x03, 0x07, 0x02, 0x01, 'z'}
	c, payload, ok, err = ParseConcat(sm)
	if err != nil || !ok || c.Ref != 7 || c.Seq != 1 || string(payload) != "z" {
		t.Fatal(c, payload, ok, err)
	}
	// UDH without concat
	_, _, ok, err = ParseConcat([]byte{0x04, 0x05, 0x02, 0x00, 0x01})
	if err != nil || ok {
		t.Fatal(ok, err)
	}
	for _, bad := range [][]byte{{}, {0x05, 0x00, 0x03}, {0x03, 0x00, 0x05, 0x01}, {0x01, 0x00}} {
		if _, _, _, err := ParseConcat(bad); err == nil {
			t.Errorf("accepted % x", bad)
		}
	}
}

func TestPrepare(t *testing.T) {
	p, err := Prepare(strings.Repeat("a", 200))
	if err != nil || p.Encoding != GSM7 || len(p.Segments) != 2 || p.DataCoding != 0 {
		t.Fatal(p, err)
	}
	msgs := p.WithUDH(9)
	if len(msgs) != 2 || len(msgs[0]) != 6+153 || msgs[1][5] != 2 {
		t.Fatal(len(msgs[0]))
	}
	if string(p.Payload()) != strings.Repeat("a", 200) {
		t.Fatal("payload")
	}
	p, _ = Prepare("hi 😀")
	if p.DataCoding != 8 || len(p.WithUDH(1)) != 1 || len(p.WithUDH(1)[0]) != 2*5 {
		t.Fatal(p)
	}
	if _, err := Prepare(strings.Repeat("a", 1531)); err != ErrTooLong {
		t.Fatal(err)
	}
}

func FuzzSplit(f *testing.F) {
	f.Add("hello €")
	f.Add(strings.Repeat("😀ж", 50))
	f.Fuzz(func(t *testing.T, s string) {
		enc := Detect(s)
		segs, err := Split(s, enc)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Join(segs, "") != s {
			t.Fatal("lossy")
		}
		if len(segs) > 1 {
			for _, x := range segs {
				if enc == GSM7 {
					if n, _ := SeptetCount(x); n > GSM7PartMax {
						t.Fatal("gsm segment too long")
					}
				} else if UTF16Len(x) > UCS2PartMax {
					t.Fatal("ucs2 segment too long")
				}
			}
		}
		b, _, err := Encode(s, enc)
		if err != nil {
			t.Fatal(err)
		}
		if utf8.ValidString(s) && Decode(enc.DataCoding(), b) != s {
			t.Fatalf("round trip %q", s)
		}
		_ = Decode(uint8(len(s)), []byte(s))
	})
}

func TestTextDataCoding(t *testing.T) {
	for _, dc := range []uint8{0, 1, 3, 6, 7, 8} {
		if !TextDataCoding(dc) {
			t.Errorf("0x%02X should be text", dc)
		}
	}
	for _, dc := range []uint8{2, 4, 0x10, 0x14, 0x18, 0xC0, 0xE0, 0xF0, 0xF4} {
		if TextDataCoding(dc) {
			t.Errorf("0x%02X should not be carried as text", dc)
		}
	}
}

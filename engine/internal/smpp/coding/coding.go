// Package coding implements SMS text encoding for SMPP: GSM 03.38 7-bit
// default alphabet (basic + extension table), UCS-2 (UTF-16BE), encoding
// detection, segment counting/splitting per CONTRACTS §3, concatenation UDH
// building/parsing, and decoding of incoming short_message bytes for the
// common data_coding values.
//
// GSM-7 is always handled UNPACKED (one septet per octet), which is what
// SMPP data_coding 0 carries on the wire.
package coding

import (
	"errors"
	"fmt"
	"unicode/utf16"
	"unicode/utf8"
)

// Encoding is the text encoding chosen for a message.
type Encoding int

const (
	GSM7 Encoding = iota // GSM 03.38 default alphabet, data_coding 0
	UCS2                 // UTF-16BE, data_coding 8
)

func (e Encoding) String() string {
	switch e {
	case GSM7:
		return "GSM7"
	case UCS2:
		return "UCS2"
	}
	return fmt.Sprintf("Encoding(%d)", int(e))
}

// DataCoding returns the SMPP data_coding value for e.
func (e Encoding) DataCoding() uint8 {
	if e == UCS2 {
		return DCUCS2
	}
	return DCDefault
}

// SMPP data_coding values (section 5.2.19).
const (
	DCDefault   uint8 = 0x00 // SMSC default alphabet (GSM 03.38 here)
	DCIA5       uint8 = 0x01 // IA5 (CCITT T.50) / ASCII
	DCBinary    uint8 = 0x02 // 8-bit binary
	DCLatin1    uint8 = 0x03 // ISO-8859-1
	DCBinary2   uint8 = 0x04 // 8-bit binary
	DCJIS       uint8 = 0x05 // JIS (X 0208-1990)
	DCCyrillic  uint8 = 0x06 // ISO-8859-5
	DCHebrew    uint8 = 0x07 // ISO-8859-8
	DCUCS2      uint8 = 0x08 // UCS-2 (ISO/IEC-10646), big endian
	DCPictogram uint8 = 0x09
	DCISO2022JP uint8 = 0x0A
	DCKanji     uint8 = 0x0D
	DCKSC5601   uint8 = 0x0E
)

// Segment limits (CONTRACTS §3).
const (
	GSM7SingleMax = 160 // septets in a single message
	GSM7PartMax   = 153 // septets per part of a concatenated message (8-bit ref UDH)
	UCS2SingleMax = 70  // UTF-16 code units in a single message
	UCS2PartMax   = 67  // UTF-16 code units per concatenated part
	MaxParts      = 10  // more parts -> MESSAGE_TOO_LONG
)

const esc = 0x1B

// gsmBasic is the GSM 03.38 default alphabet indexed by septet value.
// Index 0x1B is the escape to the extension table and is never produced by
// the reverse map.
var gsmBasic = [128]rune{
	'@', '£', '$', '¥', 'è', 'é', 'ù', 'ì', 'ò', 'Ç', '\n', 'Ø', 'ø', '\r', 'Å', 'å',
	'Δ', '_', 'Φ', 'Γ', 'Λ', 'Ω', 'Π', 'Ψ', 'Σ', 'Θ', 'Ξ', 0x1B, 'Æ', 'æ', 'ß', 'É',
	' ', '!', '"', '#', '¤', '%', '&', '\'', '(', ')', '*', '+', ',', '-', '.', '/',
	'0', '1', '2', '3', '4', '5', '6', '7', '8', '9', ':', ';', '<', '=', '>', '?',
	'¡', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O',
	'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'Ä', 'Ö', 'Ñ', 'Ü', '§',
	'¿', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o',
	'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z', 'ä', 'ö', 'ñ', 'ü', 'à',
}

// gsmExt is the GSM 03.38 extension table (reached via 0x1B).
var gsmExt = map[byte]rune{
	0x0A: '\f', 0x14: '^', 0x28: '{', 0x29: '}', 0x2F: '\\',
	0x3C: '[', 0x3D: '~', 0x3E: ']', 0x40: '|', 0x65: '€',
}

var (
	basicRev = map[rune]byte{}
	extRev   = map[rune]byte{}
)

func init() {
	for i, r := range gsmBasic {
		if i != esc {
			basicRev[r] = byte(i)
		}
	}
	for b, r := range gsmExt {
		extRev[r] = b
	}
}

// ErrNotGSM is returned when text contains characters outside GSM 03.38.
var ErrNotGSM = errors.New("coding: text is not representable in the GSM 03.38 alphabet")

// gsmSeptets returns how many septets r takes (1 basic, 2 extension) or 0 if
// r is not representable.
func gsmSeptets(r rune) int {
	if _, ok := basicRev[r]; ok {
		return 1
	}
	if _, ok := extRev[r]; ok {
		return 2
	}
	return 0
}

// IsGSM reports whether every character of text is in the GSM 03.38 basic or
// extension table.
func IsGSM(text string) bool {
	_, ok := SeptetCount(text)
	return ok
}

// SeptetCount returns the GSM-7 length of text (extension characters count
// as 2). ok is false if text is not GSM-representable.
func SeptetCount(text string) (n int, ok bool) {
	for _, r := range text {
		s := gsmSeptets(r)
		if s == 0 {
			return 0, false
		}
		n += s
	}
	return n, true
}

// UTF16Len returns the number of UTF-16 code units of text (characters
// outside the BMP, e.g. most emoji, count as 2).
func UTF16Len(text string) int {
	n := 0
	for _, r := range text {
		n += utf16Units(r)
	}
	return n
}

func utf16Units(r rune) int {
	if r >= 0x10000 && r <= utf8.MaxRune {
		return 2
	}
	return 1
}

// Detect picks GSM7 if every character is GSM-representable, else UCS2.
func Detect(text string) Encoding {
	if IsGSM(text) {
		return GSM7
	}
	return UCS2
}

// Info summarizes how a text will be sent.
type Info struct {
	Encoding Encoding
	Units    int // septets (GSM7) or UTF-16 code units (UCS2)
	Parts    int // number of SMS segments (0 for empty text is reported as 1)
}

// TooLong reports whether the message exceeds MaxParts.
func (i Info) TooLong() bool { return i.Parts > MaxParts }

// Analyze detects the encoding of text and counts its units and parts.
func Analyze(text string) Info {
	enc := Detect(text)
	units := Units(text, enc)
	return Info{Encoding: enc, Units: units, Parts: PartCount(units, enc)}
}

// Units returns the length of text in enc's units. For GSM7 text that is not
// representable the result is meaningless; use Analyze or SeptetCount.
func Units(text string, enc Encoding) int {
	if enc == GSM7 {
		n, _ := SeptetCount(text)
		return n
	}
	return UTF16Len(text)
}

// PartCount returns ceil-style segment count for a length in units: GSM7 ≤160
// → 1 else ceil(n/153); UCS2 ≤70 → 1 else ceil(n/67). This is the upper-bound
// arithmetic from CONTRACTS §3; Split may produce one more part only if
// unsplittable pairs (escape / surrogate) leave slack at segment ends — use
// len(Split(...)) when you need the exact number of PDUs.
func PartCount(units int, enc Encoding) int {
	single, part := GSM7SingleMax, GSM7PartMax
	if enc == UCS2 {
		single, part = UCS2SingleMax, UCS2PartMax
	}
	if units <= single {
		return 1
	}
	return (units + part - 1) / part
}

// Split splits text into SMS segments for enc. A text that fits a single
// message is returned as one segment. Otherwise each segment holds at most
// 153 septets (GSM7) or 67 UTF-16 code units (UCS2); segments end on
// character boundaries, so a GSM escape pair or a UTF-16 surrogate pair is
// never split. Returns ErrNotGSM if enc is GSM7 and text is not
// representable.
func Split(text string, enc Encoding) ([]string, error) {
	var single, part int
	var cost func(rune) int
	switch enc {
	case GSM7:
		single, part, cost = GSM7SingleMax, GSM7PartMax, gsmSeptets
		if !IsGSM(text) {
			return nil, ErrNotGSM
		}
	case UCS2:
		single, part, cost = UCS2SingleMax, UCS2PartMax, utf16Units
	default:
		return nil, fmt.Errorf("coding: unknown encoding %v", enc)
	}
	if Units(text, enc) <= single {
		return []string{text}, nil
	}
	var segs []string
	start, used := 0, 0
	for i, r := range text {
		c := cost(r)
		if used+c > part {
			segs = append(segs, text[start:i])
			start, used = i, 0
		}
		used += c
	}
	if start < len(text) {
		segs = append(segs, text[start:])
	}
	return segs, nil
}

// EncodeGSM7 encodes text as unpacked GSM 03.38 septets (one per octet),
// extension characters as 0x1B + code.
func EncodeGSM7(text string) ([]byte, error) {
	out := make([]byte, 0, len(text))
	for _, r := range text {
		if b, ok := basicRev[r]; ok {
			out = append(out, b)
			continue
		}
		if b, ok := extRev[r]; ok {
			out = append(out, esc, b)
			continue
		}
		return nil, fmt.Errorf("%w: %q", ErrNotGSM, r)
	}
	return out, nil
}

// EncodeUCS2 encodes text as UTF-16 big endian (surrogate pairs for
// characters outside the BMP, as handsets expect for data_coding 8).
func EncodeUCS2(text string) []byte {
	u := utf16.Encode([]rune(text))
	out := make([]byte, 2*len(u))
	for i, v := range u {
		out[2*i] = byte(v >> 8)
		out[2*i+1] = byte(v)
	}
	return out
}

// Encode encodes text with enc and returns the bytes and data_coding value.
func Encode(text string, enc Encoding) ([]byte, uint8, error) {
	switch enc {
	case GSM7:
		b, err := EncodeGSM7(text)
		return b, DCDefault, err
	case UCS2:
		return EncodeUCS2(text), DCUCS2, nil
	}
	return nil, 0, fmt.Errorf("coding: unknown encoding %v", enc)
}

// EncodeSegments splits text (Split) and encodes every segment. It is the
// building block for SAR / UDH multipart sending.
func EncodeSegments(text string, enc Encoding) ([][]byte, error) {
	segs, err := Split(text, enc)
	if err != nil {
		return nil, err
	}
	out := make([][]byte, len(segs))
	for i, s := range segs {
		if out[i], _, err = Encode(s, enc); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// Parts is a fully encoded message ready to be placed into submit_sm PDUs.
type Parts struct {
	Encoding   Encoding
	DataCoding uint8
	// Segments are the encoded segment payloads WITHOUT any UDH.
	Segments [][]byte
}

// Prepare detects the encoding, splits and encodes text, and enforces
// MaxParts (ErrTooLong).
func Prepare(text string) (Parts, error) {
	enc := Detect(text)
	segs, err := EncodeSegments(text, enc)
	if err != nil {
		return Parts{}, err
	}
	if len(segs) > MaxParts {
		return Parts{}, ErrTooLong
	}
	return Parts{Encoding: enc, DataCoding: enc.DataCoding(), Segments: segs}, nil
}

// ErrTooLong is returned when a message needs more than MaxParts segments.
var ErrTooLong = errors.New("coding: message exceeds maximum number of parts")

// WithUDH returns the short_messages for a UDH-concatenated send (esm_class
// must include 0x40 UDHI). A single segment is returned unchanged with no
// UDH (and the caller must not set UDHI).
func (p Parts) WithUDH(ref uint8) [][]byte {
	if len(p.Segments) == 1 {
		return [][]byte{p.Segments[0]}
	}
	out := make([][]byte, len(p.Segments))
	total := uint8(len(p.Segments))
	for i, s := range p.Segments {
		udh := ConcatUDH8(ref, total, uint8(i+1))
		out[i] = append(udh, s...)
	}
	return out
}

// Payload returns the whole message encoded as one byte string (for
// message_payload TLV sending).
func (p Parts) Payload() []byte {
	var n int
	for _, s := range p.Segments {
		n += len(s)
	}
	out := make([]byte, 0, n)
	for _, s := range p.Segments {
		out = append(out, s...)
	}
	return out
}

package coding

import (
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// DecodeGSM7 decodes unpacked GSM 03.38 septets. Unknown extension codes
// decode to their basic-table character (as 03.38 recommends); a trailing
// lone escape is dropped. Octets ≥ 0x80 are not valid septets and are
// interpreted as Latin-1 (best effort for misbehaving peers).
func DecodeGSM7(b []byte) string {
	var sb strings.Builder
	sb.Grow(len(b))
	for i := 0; i < len(b); i++ {
		c := b[i]
		switch {
		case c >= 0x80:
			sb.WriteRune(rune(c))
		case c == esc:
			if i+1 >= len(b) {
				continue
			}
			i++
			n := b[i]
			if r, ok := gsmExt[n]; ok {
				sb.WriteRune(r)
			} else if n < 0x80 && n != esc {
				sb.WriteRune(gsmBasic[n])
			} else if n >= 0x80 {
				sb.WriteRune(rune(n))
			} else {
				sb.WriteRune(' ')
			}
		default:
			sb.WriteRune(gsmBasic[c])
		}
	}
	return sb.String()
}

// DecodeUCS2 decodes UTF-16BE (UCS-2 plus surrogate pairs). An odd trailing
// byte is ignored; unpaired surrogates become U+FFFD.
func DecodeUCS2(b []byte) string {
	u := make([]uint16, len(b)/2)
	for i := range u {
		u[i] = uint16(b[2*i])<<8 | uint16(b[2*i+1])
	}
	return string(utf16.Decode(u))
}

// DecodeLatin1 decodes ISO-8859-1.
func DecodeLatin1(b []byte) string {
	r := make([]rune, len(b))
	for i, c := range b {
		r[i] = rune(c)
	}
	return string(r)
}

// DecodeASCII decodes IA5/ASCII; bytes ≥ 0x80 are mapped as Latin-1.
func DecodeASCII(b []byte) string { return DecodeLatin1(b) }

func decodeISO88595(b []byte) string {
	r := make([]rune, len(b))
	for i, c := range b {
		switch {
		case c < 0xA1:
			r[i] = rune(c)
		case c == 0xAD:
			r[i] = 0x00AD
		case c == 0xF0:
			r[i] = 0x2116
		case c == 0xFD:
			r[i] = 0x00A7
		default:
			r[i] = rune(c) - 0xA0 + 0x0400
		}
	}
	return string(r)
}

func decodeISO88598(b []byte) string {
	r := make([]rune, len(b))
	for i, c := range b {
		switch {
		case c >= 0xE0 && c <= 0xFA:
			r[i] = rune(c) - 0xE0 + 0x05D0
		case c == 0xAA:
			r[i] = 0x00D7
		case c == 0xBA:
			r[i] = 0x00F7
		case c == 0xDF:
			r[i] = 0x2017
		case c == 0xFD:
			r[i] = 0x200E
		case c == 0xFE:
			r[i] = 0x200F
		default:
			r[i] = rune(c)
		}
	}
	return string(r)
}

// alphabet classifies a data_coding value into GSM7 / 8-bit / UCS2, following
// SMPP 5.2.19 and the GSM 03.38 data coding scheme groups.
func alphabet(dc uint8) uint8 {
	switch {
	case dc&0xF0 == 0xF0: // data coding / message class group
		if dc&0x04 != 0 {
			return DCBinary
		}
		return DCDefault
	case dc >= 0x10 && dc <= 0x7F: // general data coding groups (bits 3-2 = alphabet)
		switch (dc >> 2) & 0x03 {
		case 0:
			return DCDefault
		case 2:
			return DCUCS2
		default:
			return DCBinary
		}
	case dc >= 0xC0 && dc <= 0xDF: // message waiting indication, GSM7
		return DCDefault
	case dc >= 0xE0 && dc <= 0xEF:
		return DCUCS2
	}
	return dc
}

// Decode converts short_message bytes to text according to data_coding:
//
//	0  GSM 03.38 unpacked (if the bytes contain octets ≥ 0x80 that form valid
//	   UTF-8, they are taken as UTF-8 — some ESMEs send UTF-8 with dc 0)
//	1  IA5/ASCII        3  Latin-1        8  UCS-2/UTF-16BE
//	6  ISO-8859-5       7  ISO-8859-8
//	2, 4 (binary) and anything unknown: UTF-8 if valid, else Latin-1.
//	GSM 03.38 DCS groups (0x10-0x7F, 0xC0-0xFF) are mapped to their alphabet.
//
// It never fails; undecodable input yields a best-effort string.
func Decode(dataCoding uint8, b []byte) string {
	switch alphabet(dataCoding) {
	case DCDefault:
		for _, c := range b {
			if c >= 0x80 {
				if utf8.Valid(b) {
					return string(b)
				}
				break
			}
		}
		return DecodeGSM7(b)
	case DCIA5:
		return DecodeASCII(b)
	case DCLatin1:
		return DecodeLatin1(b)
	case DCUCS2:
		return DecodeUCS2(b)
	case DCCyrillic:
		return decodeISO88595(b)
	case DCHebrew:
		return decodeISO88598(b)
	}
	if utf8.Valid(b) {
		return string(b)
	}
	return DecodeLatin1(b)
}

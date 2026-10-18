package coding

import (
	"errors"
	"fmt"
)

// UDH information element identifiers.
const (
	IEConcat8  = 0x00 // concatenated SM, 8-bit reference
	IEConcat16 = 0x08 // concatenated SM, 16-bit reference
)

// IE is one User Data Header information element.
type IE struct {
	ID   byte
	Data []byte
}

// Concat describes a concatenation information element.
type Concat struct {
	Ref   uint16 // reference number (0-255 for 8-bit)
	Total uint8  // total parts
	Seq   uint8  // this part, 1-based
	Ref16 bool   // true when IE 0x08 (16-bit reference) was used
}

// ConcatUDH8 builds a UDH with IE 0x00 (8-bit ref): 05 00 03 ref total seq.
func ConcatUDH8(ref uint8, total, seq uint8) []byte {
	return []byte{0x05, IEConcat8, 0x03, ref, total, seq}
}

// ConcatUDH16 builds a UDH with IE 0x08 (16-bit ref): 06 08 04 refHi refLo total seq.
func ConcatUDH16(ref uint16, total, seq uint8) []byte {
	return []byte{0x06, IEConcat16, 0x04, byte(ref >> 8), byte(ref), total, seq}
}

// ErrBadUDH is returned for a malformed User Data Header.
var ErrBadUDH = errors.New("coding: malformed user data header")

// ParseUDH splits a short_message that starts with a UDH (esm_class UDHI)
// into its information elements and the remaining payload.
func ParseUDH(sm []byte) (ies []IE, payload []byte, err error) {
	if len(sm) < 1 {
		return nil, nil, ErrBadUDH
	}
	l := int(sm[0])
	if l+1 > len(sm) {
		return nil, nil, fmt.Errorf("%w: UDHL %d exceeds message length %d", ErrBadUDH, l, len(sm)-1)
	}
	h := sm[1 : 1+l]
	for i := 0; i < len(h); {
		if len(h)-i < 2 {
			return nil, nil, fmt.Errorf("%w: truncated IE header", ErrBadUDH)
		}
		id, il := h[i], int(h[i+1])
		i += 2
		if len(h)-i < il {
			return nil, nil, fmt.Errorf("%w: IE 0x%02X length %d exceeds header", ErrBadUDH, id, il)
		}
		ies = append(ies, IE{ID: id, Data: h[i : i+il]})
		i += il
	}
	return ies, sm[1+l:], nil
}

// FindConcat returns the concatenation IE among ies (8- or 16-bit). ok is
// false if none is present or it is malformed.
func FindConcat(ies []IE) (c Concat, ok bool) {
	for _, ie := range ies {
		switch {
		case ie.ID == IEConcat8 && len(ie.Data) == 3:
			return Concat{Ref: uint16(ie.Data[0]), Total: ie.Data[1], Seq: ie.Data[2]}, true
		case ie.ID == IEConcat16 && len(ie.Data) == 4:
			return Concat{Ref: uint16(ie.Data[0])<<8 | uint16(ie.Data[1]), Total: ie.Data[2], Seq: ie.Data[3], Ref16: true}, true
		}
	}
	return Concat{}, false
}

// ParseConcat is ParseUDH + FindConcat: it reports the concat info (ok) and
// the payload after the UDH. err is non-nil only for a malformed UDH.
func ParseConcat(sm []byte) (c Concat, payload []byte, ok bool, err error) {
	ies, payload, err := ParseUDH(sm)
	if err != nil {
		return Concat{}, nil, false, err
	}
	c, ok = FindConcat(ies)
	return c, payload, ok, nil
}

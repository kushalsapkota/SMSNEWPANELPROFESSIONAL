package pdu

import (
	"encoding/binary"
	"fmt"
)

// Tag is a TLV parameter tag.
type Tag uint16

// Standard SMPP v3.4 TLV tags.
const (
	TagDestAddrSubunit          Tag = 0x0005
	TagDestNetworkType          Tag = 0x0006
	TagDestBearerType           Tag = 0x0007
	TagDestTelematicsID         Tag = 0x0008
	TagSourceAddrSubunit        Tag = 0x000D
	TagSourceNetworkType        Tag = 0x000E
	TagSourceBearerType         Tag = 0x000F
	TagSourceTelematicsID       Tag = 0x0010
	TagQosTimeToLive            Tag = 0x0017
	TagPayloadType              Tag = 0x0019
	TagAdditionalStatusInfoText Tag = 0x001D
	TagReceiptedMessageID       Tag = 0x001E
	TagMsMsgWaitFacilities      Tag = 0x0030
	TagPrivacyIndicator         Tag = 0x0201
	TagSourceSubaddress         Tag = 0x0202
	TagDestSubaddress           Tag = 0x0203
	TagUserMessageReference     Tag = 0x0204
	TagUserResponseCode         Tag = 0x0205
	TagSourcePort               Tag = 0x020A
	TagDestinationPort          Tag = 0x020B
	TagSarMsgRefNum             Tag = 0x020C
	TagLanguageIndicator        Tag = 0x020D
	TagSarTotalSegments         Tag = 0x020E
	TagSarSegmentSeqnum         Tag = 0x020F
	TagSCInterfaceVersion       Tag = 0x0210
	TagCallbackNumPresInd       Tag = 0x0302
	TagCallbackNumAtag          Tag = 0x0303
	TagNumberOfMessages         Tag = 0x0304
	TagCallbackNum              Tag = 0x0381
	TagDpfResult                Tag = 0x0420
	TagSetDpf                   Tag = 0x0421
	TagMsAvailabilityStatus     Tag = 0x0422
	TagNetworkErrorCode         Tag = 0x0423
	TagMessagePayload           Tag = 0x0424
	TagDeliveryFailureReason    Tag = 0x0425
	TagMoreMessagesToSend       Tag = 0x0426
	TagMessageState             Tag = 0x0427
	TagUssdServiceOp            Tag = 0x0501
	TagDisplayTime              Tag = 0x1201
	TagSmsSignal                Tag = 0x1203
	TagMsValidity               Tag = 0x1204
	TagAlertOnMessageDelivery   Tag = 0x130C
	TagItsReplyType             Tag = 0x1380
	TagItsSessionInfo           Tag = 0x1383
)

// TLV is one optional parameter. Value is the raw value bytes.
type TLV struct {
	Tag   Tag
	Value []byte
}

// TLVs is an ordered list of optional parameters. The zero value is empty and
// ready to use. Duplicate tags are preserved on decode; Get returns the first.
type TLVs []TLV

type tlvError struct{ msg string }

func (e *tlvError) Error() string { return "smpp: TLV: " + e.msg }

func decodeTLVs(b []byte) (TLVs, error) {
	var out TLVs
	for off := 0; off < len(b); {
		if len(b)-off < 4 {
			return nil, &tlvError{fmt.Sprintf("%d trailing bytes cannot hold a TLV header", len(b)-off)}
		}
		tag := Tag(binary.BigEndian.Uint16(b[off:]))
		l := int(binary.BigEndian.Uint16(b[off+2:]))
		off += 4
		if len(b)-off < l {
			return nil, &tlvError{fmt.Sprintf("tag 0x%04X length %d exceeds remaining %d bytes", uint16(tag), l, len(b)-off)}
		}
		out = append(out, TLV{Tag: tag, Value: append([]byte(nil), b[off:off+l]...)})
		off += l
	}
	return out, nil
}

func (t TLVs) append(b []byte) ([]byte, error) {
	for _, v := range t {
		if len(v.Value) > 0xFFFF {
			return nil, &FieldError{Field: fmt.Sprintf("tlv 0x%04X", uint16(v.Tag)), Reason: "value longer than 65535 bytes"}
		}
		b = binary.BigEndian.AppendUint16(b, uint16(v.Tag))
		b = binary.BigEndian.AppendUint16(b, uint16(len(v.Value)))
		b = append(b, v.Value...)
	}
	return b, nil
}

// Get returns the value of the first TLV with tag.
func (t TLVs) Get(tag Tag) ([]byte, bool) {
	for _, v := range t {
		if v.Tag == tag {
			return v.Value, true
		}
	}
	return nil, false
}

// Has reports whether tag is present.
func (t TLVs) Has(tag Tag) bool { _, ok := t.Get(tag); return ok }

// Set replaces every TLV with tag by a single one holding value (appended at
// the position of the first occurrence, or at the end).
func (t *TLVs) Set(tag Tag, value []byte) {
	v := append([]byte(nil), value...)
	for i := range *t {
		if (*t)[i].Tag == tag {
			(*t)[i].Value = v
			rest := (*t)[i+1:]
			kept := (*t)[:i+1]
			for _, x := range rest {
				if x.Tag != tag {
					kept = append(kept, x)
				}
			}
			*t = kept
			return
		}
	}
	*t = append(*t, TLV{Tag: tag, Value: v})
}

// Del removes every TLV with tag.
func (t *TLVs) Del(tag Tag) {
	kept := (*t)[:0]
	for _, x := range *t {
		if x.Tag != tag {
			kept = append(kept, x)
		}
	}
	*t = kept
}

func (t TLVs) u8(tag Tag) (uint8, bool) {
	v, ok := t.Get(tag)
	if !ok || len(v) != 1 {
		return 0, false
	}
	return v[0], true
}

func (t TLVs) u16(tag Tag) (uint16, bool) {
	v, ok := t.Get(tag)
	if !ok || len(v) != 2 {
		return 0, false
	}
	return binary.BigEndian.Uint16(v), true
}

// cstring decodes a C-Octet string TLV, tolerating peers that omit the NUL.
func (t TLVs) cstring(tag Tag) (string, bool) {
	v, ok := t.Get(tag)
	if !ok {
		return "", false
	}
	for i, c := range v {
		if c == 0 {
			return string(v[:i]), true
		}
	}
	return string(v), true
}

// ReceiptedMessageID returns receipted_message_id (0x001E).
func (t TLVs) ReceiptedMessageID() (string, bool) { return t.cstring(TagReceiptedMessageID) }

// SetReceiptedMessageID sets receipted_message_id (NUL-terminated, max 64 chars).
func (t *TLVs) SetReceiptedMessageID(id string) {
	t.Set(TagReceiptedMessageID, append([]byte(id), 0))
}

// MessageState is the message_state TLV value (section 5.2.28).
type MessageState uint8

// Message states.
const (
	StateEnroute       MessageState = 1
	StateDelivered     MessageState = 2
	StateExpired       MessageState = 3
	StateDeleted       MessageState = 4
	StateUndeliverable MessageState = 5
	StateAccepted      MessageState = 6
	StateUnknown       MessageState = 7
	StateRejected      MessageState = 8
)

// Stat returns the delivery receipt "stat:" word for the state
// (DELIVRD, UNDELIV, ...), or "" for unknown values.
func (s MessageState) Stat() string {
	switch s {
	case StateEnroute:
		return "ENROUTE"
	case StateDelivered:
		return "DELIVRD"
	case StateExpired:
		return "EXPIRED"
	case StateDeleted:
		return "DELETED"
	case StateUndeliverable:
		return "UNDELIV"
	case StateAccepted:
		return "ACCEPTD"
	case StateUnknown:
		return "UNKNOWN"
	case StateRejected:
		return "REJECTD"
	}
	return ""
}

// MessageStateFromStat maps a receipt stat word (any case, common long forms
// accepted) to a MessageState. Unknown words return StateUnknown, false.
func MessageStateFromStat(stat string) (MessageState, bool) {
	switch NormalizeStat(stat) {
	case "ENROUTE":
		return StateEnroute, true
	case "DELIVRD":
		return StateDelivered, true
	case "EXPIRED":
		return StateExpired, true
	case "DELETED":
		return StateDeleted, true
	case "UNDELIV":
		return StateUndeliverable, true
	case "ACCEPTD":
		return StateAccepted, true
	case "UNKNOWN":
		return StateUnknown, true
	case "REJECTD":
		return StateRejected, true
	}
	return StateUnknown, false
}

// MessageState returns message_state (0x0427).
func (t TLVs) MessageState() (MessageState, bool) {
	v, ok := t.u8(TagMessageState)
	return MessageState(v), ok
}

// SetMessageState sets message_state.
func (t *TLVs) SetMessageState(s MessageState) { t.Set(TagMessageState, []byte{byte(s)}) }

// SarMsgRefNum returns sar_msg_ref_num (0x020C).
func (t TLVs) SarMsgRefNum() (uint16, bool) { return t.u16(TagSarMsgRefNum) }

// SetSarMsgRefNum sets sar_msg_ref_num.
func (t *TLVs) SetSarMsgRefNum(ref uint16) {
	t.Set(TagSarMsgRefNum, binary.BigEndian.AppendUint16(nil, ref))
}

// SarTotalSegments returns sar_total_segments (0x020E).
func (t TLVs) SarTotalSegments() (uint8, bool) { return t.u8(TagSarTotalSegments) }

// SetSarTotalSegments sets sar_total_segments.
func (t *TLVs) SetSarTotalSegments(n uint8) { t.Set(TagSarTotalSegments, []byte{n}) }

// SarSegmentSeqnum returns sar_segment_seqnum (0x020F, 1-based).
func (t TLVs) SarSegmentSeqnum() (uint8, bool) { return t.u8(TagSarSegmentSeqnum) }

// SetSarSegmentSeqnum sets sar_segment_seqnum.
func (t *TLVs) SetSarSegmentSeqnum(n uint8) { t.Set(TagSarSegmentSeqnum, []byte{n}) }

// SAR returns the three SAR parameters if all are present and well-formed.
func (t TLVs) SAR() (ref uint16, total, seq uint8, ok bool) {
	ref, ok1 := t.SarMsgRefNum()
	total, ok2 := t.SarTotalSegments()
	seq, ok3 := t.SarSegmentSeqnum()
	return ref, total, seq, ok1 && ok2 && ok3
}

// SetSAR sets all three SAR parameters.
func (t *TLVs) SetSAR(ref uint16, total, seq uint8) {
	t.SetSarMsgRefNum(ref)
	t.SetSarTotalSegments(total)
	t.SetSarSegmentSeqnum(seq)
}

// MessagePayload returns message_payload (0x0424).
func (t TLVs) MessagePayload() ([]byte, bool) { return t.Get(TagMessagePayload) }

// SetMessagePayload sets message_payload.
func (t *TLVs) SetMessagePayload(b []byte) { t.Set(TagMessagePayload, b) }

// Network types for NetworkErrorCode.Type.
const (
	NetworkANSI136 = 1
	NetworkIS95    = 2
	NetworkGSM     = 3
	NetworkANSI41  = 4
)

// NetworkErrorCode is the network_error_code TLV (0x0423): one octet network
// type followed by a two-octet error code.
type NetworkErrorCode struct {
	Type uint8
	Code uint16
}

// NetworkErrorCode returns network_error_code.
func (t TLVs) NetworkErrorCode() (NetworkErrorCode, bool) {
	v, ok := t.Get(TagNetworkErrorCode)
	if !ok || len(v) != 3 {
		return NetworkErrorCode{}, false
	}
	return NetworkErrorCode{Type: v[0], Code: binary.BigEndian.Uint16(v[1:])}, true
}

// SetNetworkErrorCode sets network_error_code.
func (t *TLVs) SetNetworkErrorCode(n NetworkErrorCode) {
	t.Set(TagNetworkErrorCode, []byte{n.Type, byte(n.Code >> 8), byte(n.Code)})
}

// SCInterfaceVersion returns sc_interface_version (0x0210) from a bind_resp.
func (t TLVs) SCInterfaceVersion() (uint8, bool) { return t.u8(TagSCInterfaceVersion) }

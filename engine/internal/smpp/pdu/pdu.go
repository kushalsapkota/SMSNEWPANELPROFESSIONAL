// Package pdu implements the SMPP v3.4 wire format: the 16-byte header, the
// PDUs the gateway uses (bind*, unbind, submit_sm, deliver_sm, data_sm,
// enquire_link, generic_nack and their responses), C-Octet strings with the
// specification's maximum lengths, and TLV (optional parameter) handling.
//
// Decoding is defensive: every length is bounds-checked, PDUs larger than
// MaxPDULen are rejected and garbage input produces an error, never a panic.
//
// Typical use:
//
//	p, err := pdu.ReadPDU(conn)          // one PDU from a stream
//	b, err := pdu.Marshal(&pdu.SubmitSM{...})
//
// Every concrete PDU embeds Header, which carries command_status and
// sequence_number. The command_id is implied by the Go type (see
// PDU.CommandID). Unknown command ids decode to *Unknown so a session can
// answer with generic_nack(ESME_RINVCMDID).
package pdu

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"strings"
)

// CommandID is the SMPP command_id field.
type CommandID uint32

// SMPP v3.4 command ids.
const (
	CmdGenericNack         CommandID = 0x80000000
	CmdBindReceiver        CommandID = 0x00000001
	CmdBindReceiverResp    CommandID = 0x80000001
	CmdBindTransmitter     CommandID = 0x00000002
	CmdBindTransmitterResp CommandID = 0x80000002
	CmdQuerySM             CommandID = 0x00000003
	CmdQuerySMResp         CommandID = 0x80000003
	CmdSubmitSM            CommandID = 0x00000004
	CmdSubmitSMResp        CommandID = 0x80000004
	CmdDeliverSM           CommandID = 0x00000005
	CmdDeliverSMResp       CommandID = 0x80000005
	CmdUnbind              CommandID = 0x00000006
	CmdUnbindResp          CommandID = 0x80000006
	CmdReplaceSM           CommandID = 0x00000007
	CmdReplaceSMResp       CommandID = 0x80000007
	CmdCancelSM            CommandID = 0x00000008
	CmdCancelSMResp        CommandID = 0x80000008
	CmdBindTransceiver     CommandID = 0x00000009
	CmdBindTransceiverResp CommandID = 0x80000009
	CmdOutbind             CommandID = 0x0000000B
	CmdEnquireLink         CommandID = 0x00000015
	CmdEnquireLinkResp     CommandID = 0x80000015
	CmdSubmitMulti         CommandID = 0x00000021
	CmdSubmitMultiResp     CommandID = 0x80000021
	CmdAlertNotification   CommandID = 0x00000102
	CmdDataSM              CommandID = 0x00000103
	CmdDataSMResp          CommandID = 0x80000103
)

var cmdNames = map[CommandID]string{
	CmdGenericNack: "generic_nack", CmdBindReceiver: "bind_receiver", CmdBindReceiverResp: "bind_receiver_resp",
	CmdBindTransmitter: "bind_transmitter", CmdBindTransmitterResp: "bind_transmitter_resp",
	CmdQuerySM: "query_sm", CmdQuerySMResp: "query_sm_resp", CmdSubmitSM: "submit_sm", CmdSubmitSMResp: "submit_sm_resp",
	CmdDeliverSM: "deliver_sm", CmdDeliverSMResp: "deliver_sm_resp", CmdUnbind: "unbind", CmdUnbindResp: "unbind_resp",
	CmdReplaceSM: "replace_sm", CmdReplaceSMResp: "replace_sm_resp", CmdCancelSM: "cancel_sm", CmdCancelSMResp: "cancel_sm_resp",
	CmdBindTransceiver: "bind_transceiver", CmdBindTransceiverResp: "bind_transceiver_resp", CmdOutbind: "outbind",
	CmdEnquireLink: "enquire_link", CmdEnquireLinkResp: "enquire_link_resp", CmdSubmitMulti: "submit_multi",
	CmdSubmitMultiResp: "submit_multi_resp", CmdAlertNotification: "alert_notification", CmdDataSM: "data_sm",
	CmdDataSMResp: "data_sm_resp",
}

func (c CommandID) String() string {
	if n, ok := cmdNames[c]; ok {
		return n
	}
	return fmt.Sprintf("command_0x%08X", uint32(c))
}

// IsResponse reports whether c is a response command (high bit set).
func (c CommandID) IsResponse() bool { return c&0x80000000 != 0 }

// Response returns the response command id for a request id.
func (c CommandID) Response() CommandID { return c | 0x80000000 }

const (
	// HeaderLen is the size of the fixed SMPP header.
	HeaderLen = 16
	// MaxPDULen is the largest PDU (header included) this codec accepts or emits.
	MaxPDULen = 64 * 1024
	// MaxShortMessageLen is the largest short_message (sm_length is one octet;
	// the spec caps it at 254).
	MaxShortMessageLen = 254
)

// C-Octet string maximum lengths from the SMPP v3.4 spec, INCLUDING the
// terminating NUL. A Go string field may therefore hold at most max-1 bytes.
const (
	MaxSystemIDLen     = 16
	MaxPasswordLen     = 9
	MaxSystemTypeLen   = 13
	MaxAddressRangeLen = 41
	MaxServiceTypeLen  = 6
	MaxAddrLen         = 21 // source_addr / destination_addr in submit_sm / deliver_sm
	MaxDataSMAddrLen   = 65 // source_addr / destination_addr in data_sm
	MaxTimeLen         = 17 // schedule_delivery_time / validity_period
	MaxMessageIDLen    = 65
	InterfaceVersion34 = 0x34
)

// ESM class bits (section 5.2.12).
const (
	ESMClassDefault         = 0x00
	ESMClassMCDeliveryRcpt  = 0x04 // deliver_sm carries an SMSC delivery receipt
	ESMClassIntermediateNot = 0x20 // intermediate delivery notification
	ESMClassTypeMask        = 0x3C // message type bits
	ESMClassUDHI            = 0x40 // short_message starts with a User Data Header
	ESMClassReplyPath       = 0x80
)

// Registered delivery values (section 5.2.17, bits 1-0).
const (
	RegDeliveryNone      = 0x00
	RegDeliveryAlways    = 0x01 // receipt on success or failure
	RegDeliveryOnFailure = 0x02
	RegDeliveryMask      = 0x03
)

// IsDeliveryReceipt reports whether an esm_class value marks an SMSC delivery
// receipt (or intermediate notification) rather than a mobile-originated message.
func IsDeliveryReceipt(esmClass uint8) bool {
	t := esmClass & ESMClassTypeMask
	return t == ESMClassMCDeliveryRcpt || t == 0x08 /* SME delivery ack */ || t == ESMClassIntermediateNot
}

// Header holds the per-PDU header fields that are not implied by the Go type.
type Header struct {
	Status   CommandStatus
	Sequence uint32
}

// Hdr returns the header for reading or modification.
func (h *Header) Hdr() *Header { return h }

// PDU is implemented by every PDU type in this package. External packages
// cannot implement it, which guarantees that every PDU can be encoded.
type PDU interface {
	// CommandID is the command_id this PDU encodes to.
	CommandID() CommandID
	// Hdr gives access to command_status and sequence_number.
	Hdr() *Header
	appendBody(b []byte) ([]byte, error)
	decodeBody(r *reader)
}

// Errors returned by the codec.
var (
	ErrInvalidLength = errors.New("smpp: invalid command_length")
	ErrTruncated     = errors.New("smpp: PDU body truncated")
)

// FieldError reports a mandatory field that cannot be encoded or decoded.
type FieldError struct {
	Field  string
	Reason string
}

func (e *FieldError) Error() string { return "smpp: field " + e.Field + ": " + e.Reason }

// DecodeError is returned when a PDU's header was read correctly (so the
// stream is still in sync) but its body is malformed. Status is the
// command_status a peer should be answered with (generic_nack).
type DecodeError struct {
	CommandID CommandID
	Sequence  uint32
	Status    CommandStatus
	Err       error
}

func (e *DecodeError) Error() string {
	return fmt.Sprintf("smpp: decode %s (seq %d): %v", e.CommandID, e.Sequence, e.Err)
}

func (e *DecodeError) Unwrap() error { return e.Err }

// Marshal encodes p, using p.Hdr() for command_status and sequence_number.
func Marshal(p PDU) ([]byte, error) {
	h := p.Hdr()
	return MarshalWith(p, h.Status, h.Sequence)
}

// MarshalWith encodes p with the given command_status and sequence_number
// instead of the values stored in p. p is not modified, so the same PDU value
// can safely be sent on several sessions concurrently.
func MarshalWith(p PDU, status CommandStatus, seq uint32) ([]byte, error) {
	b := make([]byte, HeaderLen, 64)
	b, err := p.appendBody(b)
	if err != nil {
		return nil, err
	}
	if len(b) > MaxPDULen {
		return nil, fmt.Errorf("smpp: %s: encoded PDU is %d bytes, max %d", p.CommandID(), len(b), MaxPDULen)
	}
	binary.BigEndian.PutUint32(b[0:], uint32(len(b)))
	binary.BigEndian.PutUint32(b[4:], uint32(p.CommandID()))
	binary.BigEndian.PutUint32(b[8:], uint32(status))
	binary.BigEndian.PutUint32(b[12:], seq)
	return b, nil
}

// Unmarshal decodes exactly one PDU from b (len(b) must equal command_length).
// A malformed body returns a *DecodeError.
func Unmarshal(b []byte) (PDU, error) {
	if len(b) < HeaderLen {
		return nil, ErrInvalidLength
	}
	l := binary.BigEndian.Uint32(b[0:])
	if l < HeaderLen || l > MaxPDULen || int(l) != len(b) {
		return nil, ErrInvalidLength
	}
	id := CommandID(binary.BigEndian.Uint32(b[4:]))
	h := Header{Status: CommandStatus(binary.BigEndian.Uint32(b[8:])), Sequence: binary.BigEndian.Uint32(b[12:])}
	p := newPDU(id)
	if p == nil {
		u := &Unknown{Header: h, ID: id, Body: append([]byte(nil), b[HeaderLen:]...)}
		return u, nil
	}
	*p.Hdr() = h
	r := &reader{b: b[HeaderLen:]}
	// Error responses are frequently sent with an empty body; accept that.
	if !(id.IsResponse() && len(r.b) == 0) {
		p.decodeBody(r)
	}
	if r.err != nil {
		st := ESME_RINVCMDLEN
		var fe *FieldError
		var te *tlvError
		switch {
		case errors.As(r.err, &te):
			st = ESME_RINVOPTPARSTREAM
		case errors.As(r.err, &fe):
			st = ESME_RINVPARLEN
		}
		return nil, &DecodeError{CommandID: id, Sequence: h.Sequence, Status: st, Err: r.err}
	}
	return p, nil
}

// ReadPDU reads one PDU from r. Errors other than *DecodeError mean the stream
// can no longer be trusted (EOF, I/O error, or an invalid command_length) and
// the connection should be closed. After a *DecodeError the stream is still
// aligned on the next PDU.
func ReadPDU(r io.Reader) (PDU, error) {
	var hdr [HeaderLen]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return nil, err
	}
	l := binary.BigEndian.Uint32(hdr[0:])
	if l < HeaderLen || l > MaxPDULen {
		return nil, fmt.Errorf("%w: %d", ErrInvalidLength, l)
	}
	buf := make([]byte, l)
	copy(buf, hdr[:])
	if _, err := io.ReadFull(r, buf[HeaderLen:]); err != nil {
		if err == io.EOF {
			err = io.ErrUnexpectedEOF
		}
		return nil, err
	}
	return Unmarshal(buf)
}

func newPDU(id CommandID) PDU {
	switch id {
	case CmdBindTransmitter:
		return &Bind{BindType: BindTransmitter}
	case CmdBindReceiver:
		return &Bind{BindType: BindReceiver}
	case CmdBindTransceiver:
		return &Bind{BindType: BindTransceiver}
	case CmdBindTransmitterResp:
		return &BindResp{BindType: BindTransmitter}
	case CmdBindReceiverResp:
		return &BindResp{BindType: BindReceiver}
	case CmdBindTransceiverResp:
		return &BindResp{BindType: BindTransceiver}
	case CmdUnbind:
		return &Unbind{}
	case CmdUnbindResp:
		return &UnbindResp{}
	case CmdEnquireLink:
		return &EnquireLink{}
	case CmdEnquireLinkResp:
		return &EnquireLinkResp{}
	case CmdGenericNack:
		return &GenericNack{}
	case CmdSubmitSM:
		return &SubmitSM{}
	case CmdSubmitSMResp:
		return &SubmitSMResp{}
	case CmdDeliverSM:
		return &DeliverSM{}
	case CmdDeliverSMResp:
		return &DeliverSMResp{}
	case CmdDataSM:
		return &DataSM{}
	case CmdDataSMResp:
		return &DataSMResp{}
	}
	return nil
}

// NewResponse builds the response PDU matching request req with the given
// status and req's sequence number. Requests this package does not model
// (and *Unknown) get a generic_nack. Callers fill MessageID etc. as needed.
func NewResponse(req PDU, status CommandStatus) PDU {
	var resp PDU
	switch q := req.(type) {
	case *Bind:
		resp = &BindResp{BindType: q.BindType}
	case *Unbind:
		resp = &UnbindResp{}
	case *EnquireLink:
		resp = &EnquireLinkResp{}
	case *SubmitSM:
		resp = &SubmitSMResp{}
	case *DeliverSM:
		resp = &DeliverSMResp{}
	case *DataSM:
		resp = &DataSMResp{}
	default:
		resp = &GenericNack{}
	}
	*resp.Hdr() = Header{Status: status, Sequence: req.Hdr().Sequence}
	return resp
}

// ---------------------------------------------------------------- encoding

func appendCString(b []byte, field, s string, max int) ([]byte, error) {
	if len(s) > max-1 {
		return nil, &FieldError{Field: field, Reason: fmt.Sprintf("length %d exceeds max %d", len(s), max-1)}
	}
	for i := 0; i < len(s); i++ {
		if s[i] == 0 {
			return nil, &FieldError{Field: field, Reason: "contains NUL byte"}
		}
	}
	b = append(b, s...)
	return append(b, 0), nil
}

// reader is a sticky-error cursor over a PDU body.
type reader struct {
	b   []byte
	off int
	err error
}

func (r *reader) fail(err error) {
	if r.err == nil {
		r.err = err
	}
}

func (r *reader) remaining() int { return len(r.b) - r.off }

func (r *reader) u8(field string) uint8 {
	if r.err != nil {
		return 0
	}
	if r.remaining() < 1 {
		r.fail(fmt.Errorf("%w: reading %s", ErrTruncated, field))
		return 0
	}
	v := r.b[r.off]
	r.off++
	return v
}

func (r *reader) bytes(field string, n int) []byte {
	if r.err != nil {
		return nil
	}
	if n < 0 || r.remaining() < n {
		r.fail(fmt.Errorf("%w: reading %s (%d bytes)", ErrTruncated, field, n))
		return nil
	}
	v := make([]byte, n)
	copy(v, r.b[r.off:r.off+n])
	r.off += n
	return v
}

func (r *reader) cstring(field string, max int) string {
	if r.err != nil {
		return ""
	}
	limit := r.remaining()
	if limit > max {
		limit = max
	}
	for i := 0; i < limit; i++ {
		if r.b[r.off+i] == 0 {
			s := string(r.b[r.off : r.off+i])
			r.off += i + 1
			return s
		}
	}
	if r.remaining() < max {
		r.fail(fmt.Errorf("%w: unterminated %s", ErrTruncated, field))
	} else {
		r.fail(&FieldError{Field: field, Reason: fmt.Sprintf("no NUL within max length %d", max)})
	}
	return ""
}

func (r *reader) tlvs() TLVs {
	if r.err != nil || r.remaining() == 0 {
		return nil
	}
	t, err := decodeTLVs(r.b[r.off:])
	if err != nil {
		r.fail(err)
		return nil
	}
	r.off = len(r.b)
	return t
}

// ---------------------------------------------------------------- PDU types

// BindType distinguishes the three bind operations.
type BindType uint8

const (
	BindTransmitter BindType = iota + 1 // bind_transmitter ("TX")
	BindReceiver                        // bind_receiver ("RX")
	BindTransceiver                     // bind_transceiver ("TRX")
)

// String returns "TX", "RX" or "TRX" (the values of the bind_type DB enum).
func (t BindType) String() string {
	switch t {
	case BindTransmitter:
		return "TX"
	case BindReceiver:
		return "RX"
	case BindTransceiver:
		return "TRX"
	}
	return fmt.Sprintf("BindType(%d)", uint8(t))
}

// ParseBindType parses "TX", "RX" or "TRX" (case-insensitive).
func ParseBindType(s string) (BindType, error) {
	switch strings.ToUpper(strings.TrimSpace(s)) {
	case "TX":
		return BindTransmitter, nil
	case "RX":
		return BindReceiver, nil
	case "TRX":
		return BindTransceiver, nil
	}
	return 0, fmt.Errorf("smpp: unknown bind type %q", s)
}

// CanTransmit reports whether a session bound with t may submit messages.
func (t BindType) CanTransmit() bool { return t == BindTransmitter || t == BindTransceiver }

// CanReceive reports whether a session bound with t may receive deliver_sm.
func (t BindType) CanReceive() bool { return t == BindReceiver || t == BindTransceiver }

func (t BindType) requestID() CommandID {
	switch t {
	case BindReceiver:
		return CmdBindReceiver
	case BindTransceiver:
		return CmdBindTransceiver
	}
	return CmdBindTransmitter
}

// Bind is bind_transmitter, bind_receiver or bind_transceiver depending on
// BindType (BindTransmitter if zero).
type Bind struct {
	Header
	BindType         BindType
	SystemID         string // max 15
	Password         string // max 8
	SystemType       string // max 12
	InterfaceVersion uint8  // 0x34 for v3.4
	AddrTON          uint8
	AddrNPI          uint8
	AddressRange     string // max 40
}

func (p *Bind) CommandID() CommandID { return p.BindType.requestID() }

func (p *Bind) appendBody(b []byte) ([]byte, error) {
	var err error
	if b, err = appendCString(b, "system_id", p.SystemID, MaxSystemIDLen); err != nil {
		return nil, err
	}
	if b, err = appendCString(b, "password", p.Password, MaxPasswordLen); err != nil {
		return nil, err
	}
	if b, err = appendCString(b, "system_type", p.SystemType, MaxSystemTypeLen); err != nil {
		return nil, err
	}
	b = append(b, p.InterfaceVersion, p.AddrTON, p.AddrNPI)
	return appendCString(b, "address_range", p.AddressRange, MaxAddressRangeLen)
}

func (p *Bind) decodeBody(r *reader) {
	p.SystemID = r.cstring("system_id", MaxSystemIDLen)
	p.Password = r.cstring("password", MaxPasswordLen)
	p.SystemType = r.cstring("system_type", MaxSystemTypeLen)
	p.InterfaceVersion = r.u8("interface_version")
	p.AddrTON = r.u8("addr_ton")
	p.AddrNPI = r.u8("addr_npi")
	p.AddressRange = r.cstring("address_range", MaxAddressRangeLen)
}

// BindResp is the response to Bind.
type BindResp struct {
	Header
	BindType BindType
	SystemID string // SMSC identifier, max 15
	TLVs     TLVs   // usually sc_interface_version
}

func (p *BindResp) CommandID() CommandID { return p.BindType.requestID().Response() }

func (p *BindResp) appendBody(b []byte) ([]byte, error) {
	b, err := appendCString(b, "system_id", p.SystemID, MaxSystemIDLen)
	if err != nil {
		return nil, err
	}
	return p.TLVs.append(b)
}

func (p *BindResp) decodeBody(r *reader) {
	p.SystemID = r.cstring("system_id", MaxSystemIDLen)
	p.TLVs = r.tlvs()
}

type emptyBody struct{ Header }

func (emptyBody) appendBody(b []byte) ([]byte, error) { return b, nil }
func (emptyBody) decodeBody(r *reader)                { r.off = len(r.b) } // tolerate trailing bytes

// Unbind requests the session to be closed.
type Unbind struct{ emptyBody }

func (*Unbind) CommandID() CommandID { return CmdUnbind }

// UnbindResp answers Unbind.
type UnbindResp struct{ emptyBody }

func (*UnbindResp) CommandID() CommandID { return CmdUnbindResp }

// EnquireLink is the keepalive request.
type EnquireLink struct{ emptyBody }

func (*EnquireLink) CommandID() CommandID { return CmdEnquireLink }

// EnquireLinkResp answers EnquireLink.
type EnquireLinkResp struct{ emptyBody }

func (*EnquireLinkResp) CommandID() CommandID { return CmdEnquireLinkResp }

// GenericNack is sent in reply to an unknown or undecodable PDU.
type GenericNack struct{ emptyBody }

func (*GenericNack) CommandID() CommandID { return CmdGenericNack }

// SubmitSM is submit_sm (section 4.4.1). ShortMessage holds at most 254
// octets; use the message_payload TLV (TLVs.SetMessagePayload) for longer
// payloads, with ShortMessage empty.
type SubmitSM struct {
	Header
	ServiceType          string // max 5
	SourceAddrTON        uint8
	SourceAddrNPI        uint8
	SourceAddr           string // max 20
	DestAddrTON          uint8
	DestAddrNPI          uint8
	DestinationAddr      string // max 20
	ESMClass             uint8
	ProtocolID           uint8
	PriorityFlag         uint8
	ScheduleDeliveryTime string // max 16
	ValidityPeriod       string // max 16
	RegisteredDelivery   uint8
	ReplaceIfPresentFlag uint8
	DataCoding           uint8
	SMDefaultMsgID       uint8
	ShortMessage         []byte
	TLVs                 TLVs
}

func (p *SubmitSM) CommandID() CommandID { return CmdSubmitSM }

func (p *SubmitSM) appendBody(b []byte) ([]byte, error) {
	var err error
	if b, err = appendCString(b, "service_type", p.ServiceType, MaxServiceTypeLen); err != nil {
		return nil, err
	}
	b = append(b, p.SourceAddrTON, p.SourceAddrNPI)
	if b, err = appendCString(b, "source_addr", p.SourceAddr, MaxAddrLen); err != nil {
		return nil, err
	}
	b = append(b, p.DestAddrTON, p.DestAddrNPI)
	if b, err = appendCString(b, "destination_addr", p.DestinationAddr, MaxAddrLen); err != nil {
		return nil, err
	}
	b = append(b, p.ESMClass, p.ProtocolID, p.PriorityFlag)
	if b, err = appendCString(b, "schedule_delivery_time", p.ScheduleDeliveryTime, MaxTimeLen); err != nil {
		return nil, err
	}
	if b, err = appendCString(b, "validity_period", p.ValidityPeriod, MaxTimeLen); err != nil {
		return nil, err
	}
	if len(p.ShortMessage) > MaxShortMessageLen {
		return nil, &FieldError{Field: "short_message", Reason: fmt.Sprintf("length %d exceeds %d; use message_payload", len(p.ShortMessage), MaxShortMessageLen)}
	}
	b = append(b, p.RegisteredDelivery, p.ReplaceIfPresentFlag, p.DataCoding, p.SMDefaultMsgID, uint8(len(p.ShortMessage)))
	b = append(b, p.ShortMessage...)
	return p.TLVs.append(b)
}

func (p *SubmitSM) decodeBody(r *reader) {
	p.ServiceType = r.cstring("service_type", MaxServiceTypeLen)
	p.SourceAddrTON = r.u8("source_addr_ton")
	p.SourceAddrNPI = r.u8("source_addr_npi")
	p.SourceAddr = r.cstring("source_addr", MaxAddrLen)
	p.DestAddrTON = r.u8("dest_addr_ton")
	p.DestAddrNPI = r.u8("dest_addr_npi")
	p.DestinationAddr = r.cstring("destination_addr", MaxAddrLen)
	p.ESMClass = r.u8("esm_class")
	p.ProtocolID = r.u8("protocol_id")
	p.PriorityFlag = r.u8("priority_flag")
	p.ScheduleDeliveryTime = r.cstring("schedule_delivery_time", MaxTimeLen)
	p.ValidityPeriod = r.cstring("validity_period", MaxTimeLen)
	p.RegisteredDelivery = r.u8("registered_delivery")
	p.ReplaceIfPresentFlag = r.u8("replace_if_present_flag")
	p.DataCoding = r.u8("data_coding")
	p.SMDefaultMsgID = r.u8("sm_default_msg_id")
	n := r.u8("sm_length")
	p.ShortMessage = r.bytes("short_message", int(n))
	p.TLVs = r.tlvs()
}

// Payload returns the message body: the message_payload TLV if present,
// otherwise ShortMessage.
func (p *SubmitSM) Payload() []byte {
	if v, ok := p.TLVs.MessagePayload(); ok {
		return v
	}
	return p.ShortMessage
}

// DeliverSM is deliver_sm (section 4.6.1). It has exactly the same layout as
// submit_sm (schedule_delivery_time / validity_period / replace_if_present /
// sm_default_msg_id are unused and should be empty/zero). A *DeliverSM can be
// converted to *SubmitSM and back with a plain type conversion.
type DeliverSM SubmitSM

func (p *DeliverSM) CommandID() CommandID                { return CmdDeliverSM }
func (p *DeliverSM) appendBody(b []byte) ([]byte, error) { return (*SubmitSM)(p).appendBody(b) }
func (p *DeliverSM) decodeBody(r *reader)                { (*SubmitSM)(p).decodeBody(r) }

// Payload returns the message_payload TLV if present, otherwise ShortMessage.
func (p *DeliverSM) Payload() []byte { return (*SubmitSM)(p).Payload() }

// SubmitSMResp answers SubmitSM. MessageID is the SMSC message id (max 64).
type SubmitSMResp struct {
	Header
	MessageID string
	TLVs      TLVs // not in v3.4, but tolerated (SMPP 5.0 peers)
}

func (p *SubmitSMResp) CommandID() CommandID { return CmdSubmitSMResp }

func (p *SubmitSMResp) appendBody(b []byte) ([]byte, error) {
	b, err := appendCString(b, "message_id", p.MessageID, MaxMessageIDLen)
	if err != nil {
		return nil, err
	}
	return p.TLVs.append(b)
}

func (p *SubmitSMResp) decodeBody(r *reader) {
	p.MessageID = r.cstring("message_id", MaxMessageIDLen)
	p.TLVs = r.tlvs()
}

// DeliverSMResp answers DeliverSM. MessageID is normally empty.
type DeliverSMResp struct {
	Header
	MessageID string
	TLVs      TLVs
}

func (p *DeliverSMResp) CommandID() CommandID { return CmdDeliverSMResp }
func (p *DeliverSMResp) appendBody(b []byte) ([]byte, error) {
	return (*SubmitSMResp)(p).appendBody(b)
}
func (p *DeliverSMResp) decodeBody(r *reader) { (*SubmitSMResp)(p).decodeBody(r) }

// DataSM is data_sm (section 4.7.1). The body is carried in the
// message_payload TLV.
type DataSM struct {
	Header
	ServiceType        string
	SourceAddrTON      uint8
	SourceAddrNPI      uint8
	SourceAddr         string // max 64
	DestAddrTON        uint8
	DestAddrNPI        uint8
	DestinationAddr    string // max 64
	ESMClass           uint8
	RegisteredDelivery uint8
	DataCoding         uint8
	TLVs               TLVs
}

func (p *DataSM) CommandID() CommandID { return CmdDataSM }

func (p *DataSM) appendBody(b []byte) ([]byte, error) {
	var err error
	if b, err = appendCString(b, "service_type", p.ServiceType, MaxServiceTypeLen); err != nil {
		return nil, err
	}
	b = append(b, p.SourceAddrTON, p.SourceAddrNPI)
	if b, err = appendCString(b, "source_addr", p.SourceAddr, MaxDataSMAddrLen); err != nil {
		return nil, err
	}
	b = append(b, p.DestAddrTON, p.DestAddrNPI)
	if b, err = appendCString(b, "destination_addr", p.DestinationAddr, MaxDataSMAddrLen); err != nil {
		return nil, err
	}
	b = append(b, p.ESMClass, p.RegisteredDelivery, p.DataCoding)
	return p.TLVs.append(b)
}

func (p *DataSM) decodeBody(r *reader) {
	p.ServiceType = r.cstring("service_type", MaxServiceTypeLen)
	p.SourceAddrTON = r.u8("source_addr_ton")
	p.SourceAddrNPI = r.u8("source_addr_npi")
	p.SourceAddr = r.cstring("source_addr", MaxDataSMAddrLen)
	p.DestAddrTON = r.u8("dest_addr_ton")
	p.DestAddrNPI = r.u8("dest_addr_npi")
	p.DestinationAddr = r.cstring("destination_addr", MaxDataSMAddrLen)
	p.ESMClass = r.u8("esm_class")
	p.RegisteredDelivery = r.u8("registered_delivery")
	p.DataCoding = r.u8("data_coding")
	p.TLVs = r.tlvs()
}

// DataSMResp answers DataSM.
type DataSMResp struct {
	Header
	MessageID string
	TLVs      TLVs
}

func (p *DataSMResp) CommandID() CommandID { return CmdDataSMResp }
func (p *DataSMResp) appendBody(b []byte) ([]byte, error) {
	return (*SubmitSMResp)(p).appendBody(b)
}
func (p *DataSMResp) decodeBody(r *reader) { (*SubmitSMResp)(p).decodeBody(r) }

// Unknown holds a PDU whose command_id this package does not model.
type Unknown struct {
	Header
	ID   CommandID
	Body []byte
}

func (p *Unknown) CommandID() CommandID                { return p.ID }
func (p *Unknown) appendBody(b []byte) ([]byte, error) { return append(b, p.Body...), nil }
func (p *Unknown) decodeBody(r *reader)                { p.Body = r.bytes("body", r.remaining()) }

package pdu

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"reflect"
	"testing"
	"time"
)

func roundTrip(t *testing.T, p PDU) PDU {
	t.Helper()
	b, err := Marshal(p)
	if err != nil {
		t.Fatalf("marshal %T: %v", p, err)
	}
	if got := binary.BigEndian.Uint32(b); int(got) != len(b) {
		t.Fatalf("command_length %d != %d", got, len(b))
	}
	q, err := ReadPDU(bytes.NewReader(b))
	if err != nil {
		t.Fatalf("decode %T: %v", p, err)
	}
	if !reflect.DeepEqual(p, q) {
		t.Fatalf("round trip mismatch\n got %#v\nwant %#v", q, p)
	}
	return q
}

func TestRoundTripAll(t *testing.T) {
	var tl TLVs
	tl.SetSAR(0xBEEF, 3, 2)
	tl.SetMessagePayload([]byte("payload bytes"))
	tl.SetReceiptedMessageID("abc123")
	tl.SetMessageState(StateDelivered)
	tl.SetNetworkErrorCode(NetworkErrorCode{Type: NetworkGSM, Code: 0x0102})

	cases := []PDU{
		&Bind{Header: Header{Sequence: 1}, BindType: BindTransmitter, SystemID: "sysid", Password: "secret12", SystemType: "VMA", InterfaceVersion: 0x34, AddrTON: 1, AddrNPI: 1, AddressRange: "^91"},
		&Bind{Header: Header{Sequence: 2}, BindType: BindReceiver, SystemID: "a"},
		&Bind{Header: Header{Sequence: 3}, BindType: BindTransceiver, SystemID: "123456789012345", Password: "12345678"},
		&BindResp{Header: Header{Sequence: 3}, BindType: BindTransceiver, SystemID: "SMSC", TLVs: TLVs{{Tag: TagSCInterfaceVersion, Value: []byte{0x34}}}},
		&BindResp{Header: Header{Sequence: 4, Status: ESME_RINVPASWD}, BindType: BindReceiver},
		&Unbind{emptyBody{Header{Sequence: 5}}},
		&UnbindResp{emptyBody{Header{Sequence: 5}}},
		&EnquireLink{emptyBody{Header{Sequence: 6}}},
		&EnquireLinkResp{emptyBody{Header{Sequence: 6}}},
		&GenericNack{emptyBody{Header{Sequence: 7, Status: ESME_RINVCMDID}}},
		&SubmitSM{Header: Header{Sequence: 8}, ServiceType: "CMT", SourceAddrTON: 5, SourceAddr: "MYBANK", DestAddrTON: 1, DestAddrNPI: 1,
			DestinationAddr: "919876543210", ESMClass: ESMClassUDHI, RegisteredDelivery: 1, DataCoding: 8, ShortMessage: []byte{0x05, 0, 3, 1, 2, 1, 0, 'A'},
			ValidityPeriod: "000001000000000R", TLVs: tl},
		&SubmitSMResp{Header: Header{Sequence: 8}, MessageID: "0123456789abcdef"},
		&DeliverSM{Header: Header{Sequence: 9}, SourceAddr: "919876543210", DestinationAddr: "MYBANK", ESMClass: ESMClassMCDeliveryRcpt,
			ShortMessage: []byte("id:1 stat:DELIVRD"), TLVs: TLVs{{Tag: TagReceiptedMessageID, Value: []byte("1\x00")}}},
		&DeliverSMResp{Header: Header{Sequence: 9}},
		&DataSM{Header: Header{Sequence: 10}, SourceAddr: "1234567890123456789012345678901234567890", DestinationAddr: "x", DataCoding: 0, TLVs: TLVs{{Tag: TagMessagePayload, Value: bytes.Repeat([]byte("z"), 1000)}}},
		&DataSMResp{Header: Header{Sequence: 10}, MessageID: "m1"},
	}
	for _, p := range cases {
		roundTrip(t, p)
	}
}

func TestEmptyErrorResponseBody(t *testing.T) {
	// bind_transmitter_resp with error status and no body at all
	b := make([]byte, 16)
	binary.BigEndian.PutUint32(b[0:], 16)
	binary.BigEndian.PutUint32(b[4:], uint32(CmdBindTransmitterResp))
	binary.BigEndian.PutUint32(b[8:], uint32(ESME_RINVPASWD))
	binary.BigEndian.PutUint32(b[12:], 42)
	p, err := Unmarshal(b)
	if err != nil {
		t.Fatal(err)
	}
	r := p.(*BindResp)
	if r.Status != ESME_RINVPASWD || r.Sequence != 42 || r.BindType != BindTransmitter {
		t.Fatalf("got %#v", r)
	}
	binary.BigEndian.PutUint32(b[4:], uint32(CmdSubmitSMResp))
	binary.BigEndian.PutUint32(b[8:], uint32(ESME_RTHROTTLED))
	p, err = Unmarshal(b)
	if err != nil || p.(*SubmitSMResp).Status != ESME_RTHROTTLED {
		t.Fatalf("got %#v %v", p, err)
	}
}

func TestEncodeLimits(t *testing.T) {
	if _, err := Marshal(&Bind{SystemID: "1234567890123456"}); err == nil {
		t.Fatal("expected system_id too long")
	}
	if _, err := Marshal(&Bind{Password: "123456789"}); err == nil {
		t.Fatal("expected password too long")
	}
	if _, err := Marshal(&SubmitSM{ShortMessage: make([]byte, 255)}); err == nil {
		t.Fatal("expected short_message too long")
	}
	if _, err := Marshal(&SubmitSM{SourceAddr: "a\x00b"}); err == nil {
		t.Fatal("expected NUL rejection")
	}
	if _, err := Marshal(&SubmitSM{ShortMessage: make([]byte, 254)}); err != nil {
		t.Fatal(err)
	}
	var tl TLVs
	tl.SetMessagePayload(make([]byte, MaxPDULen))
	if _, err := Marshal(&SubmitSM{TLVs: tl}); err == nil {
		t.Fatal("expected oversize PDU")
	}
}

func TestDecodeErrors(t *testing.T) {
	// Length too big.
	hdr := make([]byte, 16)
	binary.BigEndian.PutUint32(hdr, MaxPDULen+1)
	if _, err := ReadPDU(bytes.NewReader(hdr)); !errors.Is(err, ErrInvalidLength) {
		t.Fatalf("want ErrInvalidLength, got %v", err)
	}
	binary.BigEndian.PutUint32(hdr, 8)
	if _, err := ReadPDU(bytes.NewReader(hdr)); !errors.Is(err, ErrInvalidLength) {
		t.Fatalf("want ErrInvalidLength, got %v", err)
	}
	// Truncated stream.
	b, _ := Marshal(&SubmitSM{SourceAddr: "abc"})
	if _, err := ReadPDU(bytes.NewReader(b[:len(b)-3])); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("want unexpected EOF, got %v", err)
	}
	// Body truncated but length consistent -> DecodeError, stream continues.
	bad := append([]byte(nil), b[:20]...)
	binary.BigEndian.PutUint32(bad, uint32(len(bad)))
	stream := append(bad, mustMarshal(t, &EnquireLink{emptyBody{Header{Sequence: 77}}})...)
	r := bytes.NewReader(stream)
	_, err := ReadPDU(r)
	var de *DecodeError
	if !errors.As(err, &de) || de.CommandID != CmdSubmitSM || de.Status != ESME_RINVCMDLEN {
		t.Fatalf("want DecodeError, got %v", err)
	}
	p, err := ReadPDU(r)
	if err != nil || p.Hdr().Sequence != 77 {
		t.Fatalf("stream not resynchronised: %v %v", p, err)
	}
	// Bad TLV.
	b, _ = Marshal(&SubmitSM{})
	b = append(b, 0x04, 0x24, 0x00, 0x10, 'x')
	binary.BigEndian.PutUint32(b, uint32(len(b)))
	_, err = Unmarshal(b)
	if !errors.As(err, &de) || de.Status != ESME_RINVOPTPARSTREAM {
		t.Fatalf("want TLV DecodeError, got %v", err)
	}
	// Overlong C-string.
	b, _ = Marshal(&Bind{})
	long := append(b[:16:16], bytes.Repeat([]byte("a"), 40)...)
	long = append(long, 0, 0, 0, 0x34, 0, 0, 0)
	binary.BigEndian.PutUint32(long, uint32(len(long)))
	_, err = Unmarshal(long)
	if !errors.As(err, &de) || de.Status != ESME_RINVPARLEN {
		t.Fatalf("want field DecodeError, got %v", err)
	}
}

func mustMarshal(t *testing.T, p PDU) []byte {
	b, err := Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestUnknownCommand(t *testing.T) {
	b := make([]byte, 20)
	binary.BigEndian.PutUint32(b, 20)
	binary.BigEndian.PutUint32(b[4:], 0x00000099)
	binary.BigEndian.PutUint32(b[12:], 5)
	copy(b[16:], "abcd")
	p, err := Unmarshal(b)
	if err != nil {
		t.Fatal(err)
	}
	u := p.(*Unknown)
	if u.ID != 0x99 || string(u.Body) != "abcd" || u.Sequence != 5 {
		t.Fatalf("%#v", u)
	}
	nack := NewResponse(u, ESME_RINVCMDID)
	if nack.CommandID() != CmdGenericNack || nack.Hdr().Sequence != 5 || nack.Hdr().Status != ESME_RINVCMDID {
		t.Fatalf("%#v", nack)
	}
	again, _ := Marshal(u)
	if !bytes.Equal(again, b) {
		t.Fatal("unknown re-encode mismatch")
	}
}

func TestNewResponse(t *testing.T) {
	cases := map[PDU]CommandID{
		&Bind{BindType: BindReceiver}: CmdBindReceiverResp, &Bind{}: CmdBindTransmitterResp,
		&SubmitSM{}: CmdSubmitSMResp, &DeliverSM{}: CmdDeliverSMResp, &DataSM{}: CmdDataSMResp,
		&Unbind{}: CmdUnbindResp, &EnquireLink{}: CmdEnquireLinkResp,
	}
	for req, want := range cases {
		req.Hdr().Sequence = 9
		r := NewResponse(req, ESME_ROK)
		if r.CommandID() != want || r.Hdr().Sequence != 9 {
			t.Errorf("%T -> %s", req, r.CommandID())
		}
		if req.CommandID().Response() != want {
			t.Errorf("Response() mismatch for %T", req)
		}
	}
}

func TestMarshalWithDoesNotMutate(t *testing.T) {
	p := &SubmitSM{Header: Header{Sequence: 1}}
	b, _ := MarshalWith(p, ESME_ROK, 99)
	if p.Sequence != 1 || binary.BigEndian.Uint32(b[12:]) != 99 {
		t.Fatal("MarshalWith mutated or ignored seq")
	}
}

func TestTLVHelpers(t *testing.T) {
	var tl TLVs
	if _, ok := tl.MessageState(); ok {
		t.Fatal("empty")
	}
	tl.SetMessageState(StateUndeliverable)
	tl.SetMessageState(StateDelivered)
	if len(tl) != 1 {
		t.Fatalf("Set duplicated: %v", tl)
	}
	st, _ := tl.MessageState()
	if st != StateDelivered || st.Stat() != "DELIVRD" {
		t.Fatal(st)
	}
	tl = append(tl, TLV{Tag: TagReceiptedMessageID, Value: []byte("no-nul")})
	if id, _ := tl.ReceiptedMessageID(); id != "no-nul" {
		t.Fatal(id)
	}
	tl.SetReceiptedMessageID("withnul")
	if id, _ := tl.ReceiptedMessageID(); id != "withnul" {
		t.Fatal(id)
	}
	tl.SetSAR(513, 4, 3)
	ref, tot, seq, ok := tl.SAR()
	if !ok || ref != 513 || tot != 4 || seq != 3 {
		t.Fatal(ref, tot, seq, ok)
	}
	tl.SetNetworkErrorCode(NetworkErrorCode{Type: 3, Code: 0xABCD})
	if n, _ := tl.NetworkErrorCode(); n.Type != 3 || n.Code != 0xABCD {
		t.Fatal(n)
	}
	tl.Del(TagSarMsgRefNum)
	if _, _, _, ok := tl.SAR(); ok {
		t.Fatal("SAR should be incomplete")
	}
	// malformed lengths are reported as absent
	bad := TLVs{{Tag: TagMessageState, Value: []byte{1, 2}}}
	if _, ok := bad.MessageState(); ok {
		t.Fatal("bad length accepted")
	}
	if s, ok := MessageStateFromStat("delivered"); !ok || s != StateDelivered {
		t.Fatal(s)
	}
}

func TestReceiptFormatParse(t *testing.T) {
	sd := time.Date(2026, 10, 18, 9, 30, 0, 0, time.UTC)
	dd := sd.Add(2 * time.Minute)
	r := Receipt{ID: "4f2a", Sub: 1, Dlvrd: 1, SubmitDate: sd, DoneDate: dd, Stat: "DELIVRD", Err: "000", Text: "Your code is 849201 thanks"}
	s := r.Format()
	want := "id:4f2a sub:001 dlvrd:001 submit date:2610180930 done date:2610180932 stat:DELIVRD err:000 text:Your code is 849201 "
	if s != want {
		t.Fatalf("Format:\n got %q\nwant %q", s, want)
	}
	p, err := ParseReceipt(s)
	if err != nil {
		t.Fatal(err)
	}
	if p.ID != "4f2a" || p.Sub != 1 || p.Dlvrd != 1 || !p.SubmitDate.Equal(sd) || !p.DoneDate.Equal(dd) || p.Stat != "DELIVRD" || p.Err != "000" || p.Text != "Your code is 849201 " {
		t.Fatalf("%+v", p)
	}
}

func TestReceiptVariants(t *testing.T) {
	cases := []struct {
		in             string
		id, stat, err  string
		text           string
		sub, dlvrd     int
		submit, doneOK bool
	}{
		{in: "id:123456 sub:001 dlvrd:000 submit date:2310181200 done date:2310181201 stat:UNDELIV err:001 text:hello", id: "123456", stat: "UNDELIV", err: "001", text: "hello", sub: 1, submit: true, doneOK: true},
		{in: "ID:ABCDEF SUB:001 DLVRD:001 SUBMIT DATE:2310181200 DONE DATE:2310181201 STAT:DELIVRD ERR:000 TEXT:Hi", id: "ABCDEF", stat: "DELIVRD", err: "000", text: "Hi", sub: 1, dlvrd: 1, submit: true, doneOK: true},
		{in: "id:77 stat:delivrd", id: "77", stat: "DELIVRD"},
		{in: "id:77 submit_date:231018120000 done_date:231018120130 stat:EXPIRED err:000 Text:a:b:c", id: "77", stat: "EXPIRED", err: "000", text: "a:b:c", submit: true, doneOK: true},
		{in: "stat:REJECTD err:0x0B id:x-1", id: "x-1", stat: "REJECTD", err: "0x0B"},
		{in: "id: 99  sub: 1  dlvrd: 1 submit date: 2310181200 done date: 2310181201 stat: DELIVERED err: 0", id: "99", stat: "DELIVRD", err: "0", sub: 1, dlvrd: 1, submit: true, doneOK: true},
		{in: "id:5 submitdate:20231018120000 donedate:bogus stat:UNKNOWN\x00", id: "5", stat: "UNKNOWN", submit: true},
		{in: "id:0000012345 status:ACCEPTED", id: "0000012345", stat: "ACCEPTD"},
		{in: "id:1 text: stat:DELIVRD is text", id: "1", text: "stat:DELIVRD is text"},
	}
	for _, c := range cases {
		r, err := ParseReceipt(c.in)
		if err != nil {
			t.Errorf("%q: %v", c.in, err)
			continue
		}
		if r.ID != c.id || r.Stat != c.stat || r.Err != c.err || r.Text != c.text || r.Sub != c.sub || r.Dlvrd != c.dlvrd ||
			r.SubmitDate.IsZero() == c.submit || r.DoneDate.IsZero() == c.doneOK {
			t.Errorf("%q: got %+v", c.in, r)
		}
	}
	if _, err := ParseReceipt("hello world, nothing here"); !errors.Is(err, ErrNotReceipt) {
		t.Fatal("expected ErrNotReceipt")
	}
	if _, err := ParseReceipt("paid:12 valid"); !errors.Is(err, ErrNotReceipt) {
		t.Fatal("'paid:' must not match 'id:'")
	}
}

func TestReceiptFromDeliverSM(t *testing.T) {
	d := &DeliverSM{ESMClass: ESMClassMCDeliveryRcpt, ShortMessage: []byte("id:1A2B sub:001 dlvrd:001 submit date:2310181200 done date:2310181201 stat:DELIVRD err:000 text:x")}
	r, ok := ReceiptFromDeliverSM(d)
	if !ok || r.ID != "1A2B" || r.Stat != "DELIVRD" {
		t.Fatal(r, ok)
	}
	// TLV overrides id; message_state fills missing stat
	d = &DeliverSM{ESMClass: ESMClassMCDeliveryRcpt, ShortMessage: []byte("garbage")}
	d.TLVs.SetReceiptedMessageID("tlv-id")
	d.TLVs.SetMessageState(StateUndeliverable)
	r, ok = ReceiptFromDeliverSM(d)
	if !ok || r.ID != "tlv-id" || r.Stat != "UNDELIV" {
		t.Fatal(r, ok)
	}
	// payload in message_payload
	d = &DeliverSM{ESMClass: ESMClassMCDeliveryRcpt}
	d.TLVs.SetMessagePayload([]byte("id:9 stat:EXPIRED"))
	if r, ok = ReceiptFromDeliverSM(d); !ok || r.ID != "9" || r.Stat != "EXPIRED" {
		t.Fatal(r, ok)
	}
	// MO message is not a receipt
	if _, ok := ReceiptFromDeliverSM(&DeliverSM{ShortMessage: []byte("id:1 stat:DELIVRD")}); ok {
		t.Fatal("MO treated as receipt")
	}
}

func TestMessageIDVariants(t *testing.T) {
	if NormalizeMessageID(" 00ABC\x00") != "abc" || NormalizeMessageID("000") != "0" {
		t.Fatal("normalize")
	}
	has := func(v []string, s string) bool {
		for _, x := range v {
			if x == s {
				return true
			}
		}
		return false
	}
	v := MessageIDVariants("1715004") // decimal of 0x1a2b3c
	if v[0] != "1715004" || !has(v, "1a2b3c") {
		t.Fatal(v)
	}
	v = MessageIDVariants("1A2B3C")
	if v[0] != "1a2b3c" || !has(v, "1715004") {
		t.Fatal(v)
	}
	v = MessageIDVariants("msg-xyz")
	if len(v) != 1 || v[0] != "msg-xyz" {
		t.Fatal(v)
	}
	// huge decimal beyond uint64 still converts
	v = MessageIDVariants("123456789012345678901234567890")
	if len(v) < 2 {
		t.Fatal(v)
	}
}

func TestBindType(t *testing.T) {
	for _, s := range []string{"TX", "rx", "Trx"} {
		bt, err := ParseBindType(s)
		if err != nil {
			t.Fatal(err)
		}
		if bt.String() != map[string]string{"TX": "TX", "rx": "RX", "Trx": "TRX"}[s] {
			t.Fatal(bt)
		}
	}
	if _, err := ParseBindType("XX"); err == nil {
		t.Fatal("expected error")
	}
	if !BindTransceiver.CanReceive() || !BindTransceiver.CanTransmit() || BindReceiver.CanTransmit() || BindTransmitter.CanReceive() {
		t.Fatal("capabilities")
	}
}

func TestStatusStrings(t *testing.T) {
	if ESME_RTHROTTLED.String() != "ESME_RTHROTTLED" || CommandStatus(0x400).String() != "0x00000400" {
		t.Fatal("status string")
	}
	e := &StatusError{Command: CmdSubmitSMResp, Status: ESME_RSUBMITFAIL}
	if e.Error() != "smpp: submit_sm_resp: ESME_RSUBMITFAIL (0x00000045)" {
		t.Fatal(e.Error())
	}
}

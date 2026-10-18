package pdu

import (
	"bytes"
	"encoding/binary"
	"testing"
)

// FuzzUnmarshal checks that arbitrary bytes never panic the decoder and that
// anything that decodes re-encodes to a PDU that decodes to the same value.
func FuzzUnmarshal(f *testing.F) {
	seeds := []PDU{
		&Bind{BindType: BindTransceiver, SystemID: "s", Password: "p", InterfaceVersion: 0x34},
		&BindResp{BindType: BindTransmitter, SystemID: "smsc"},
		&SubmitSM{SourceAddr: "a", DestinationAddr: "b", ShortMessage: []byte("hi"), TLVs: TLVs{{Tag: TagSarMsgRefNum, Value: []byte{0, 1}}}},
		&DeliverSM{ESMClass: 4, ShortMessage: []byte("id:1 stat:DELIVRD")},
		&SubmitSMResp{MessageID: "x"},
		&DataSM{TLVs: TLVs{{Tag: TagMessagePayload, Value: []byte("p")}}},
		&EnquireLink{},
	}
	for _, s := range seeds {
		b, err := Marshal(s)
		if err != nil {
			f.Fatal(err)
		}
		f.Add(b)
	}
	f.Add([]byte{0, 0, 0, 16, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 1})
	f.Fuzz(func(t *testing.T, data []byte) {
		// Exercise both the framed reader and the direct decoder.
		_, _ = ReadPDU(bytes.NewReader(data))
		if len(data) >= 4 {
			fixed := append([]byte(nil), data...)
			binary.BigEndian.PutUint32(fixed, uint32(len(fixed)))
			data = fixed
		}
		p, err := Unmarshal(data)
		if err != nil {
			return
		}
		b, err := Marshal(p)
		if err != nil {
			// Decoded values always fit the encoder's limits except
			// sm_length (one octet) which can't overflow on decode.
			t.Fatalf("re-encode of decoded %T failed: %v", p, err)
		}
		q, err := Unmarshal(b)
		if err != nil {
			t.Fatalf("decode of re-encoded %T failed: %v", p, err)
		}
		b2, _ := Marshal(q)
		if !bytes.Equal(b, b2) {
			t.Fatalf("unstable encoding for %T", p)
		}
		_, _ = ReceiptFromDeliverSMIfAny(q)
	})
}

// ReceiptFromDeliverSMIfAny is a test helper exercising receipt parsing on fuzzed PDUs.
func ReceiptFromDeliverSMIfAny(p PDU) (Receipt, bool) {
	if d, ok := p.(*DeliverSM); ok {
		return ReceiptFromDeliverSM(d)
	}
	return Receipt{}, false
}

func FuzzParseReceipt(f *testing.F) {
	f.Add("id:123 sub:001 dlvrd:001 submit date:2310181200 done date:2310181201 stat:DELIVRD err:000 text:x")
	f.Add("ID:a STAT:undeliv")
	f.Add("text:")
	f.Fuzz(func(t *testing.T, s string) {
		r, err := ParseReceipt(s)
		if err == nil {
			_ = r.Format()
		}
		_ = MessageIDVariants(s)
	})
}

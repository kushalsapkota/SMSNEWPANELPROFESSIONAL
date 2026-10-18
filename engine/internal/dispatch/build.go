package dispatch

import (
	"fmt"
	"math/rand/v2"

	"smsgw/engine/internal/phone"
	"smsgw/engine/internal/pipeline"
	"smsgw/engine/internal/smpp/coding"
	"smsgw/engine/internal/smpp/pdu"
	"smsgw/engine/internal/store"
)

// Multipart modes (upstream_connections.multipart_mode).
const (
	ModeUDH     = "UDH"
	ModeSAR     = "SAR"
	ModePayload = "PAYLOAD"
)

// encodeText returns the encoded segments and data_coding for a job on conn.
//
// UCS-2 text is always data_coding 8. GSM-7 text uses the connection's
// default_data_coding when it is 0 (SMSC default alphabet, GSM 03.38
// septets) or 1 (IA5/ASCII — used only when the text is plain printable
// ASCII, otherwise GSM 03.38 with data_coding 0). Other values are not
// segment-compatible with GSM-7 limits and fall back to data_coding 0.
func encodeText(text, enc string, conn *store.Connection) ([][]byte, uint8, error) {
	e := coding.GSM7
	if enc == "UCS2" {
		e = coding.UCS2
	}
	if e == coding.GSM7 && !coding.IsGSM(text) {
		e = coding.UCS2 // defensive: never send unrepresentable text as GSM
	}
	segs, err := coding.Split(text, e)
	if err != nil {
		return nil, 0, err
	}
	dc := e.DataCoding()
	ascii := e == coding.GSM7 && conn != nil && conn.DefaultDataCoding == int(coding.DCIA5) && isPrintableASCII(text)
	if ascii {
		dc = coding.DCIA5
	}
	out := make([][]byte, len(segs))
	for i, s := range segs {
		if ascii {
			out[i] = []byte(s)
			continue
		}
		b, _, err := coding.Encode(s, e)
		if err != nil {
			return nil, 0, err
		}
		out[i] = b
	}
	return out, dc, nil
}

func isPrintableASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c < 0x20 || c > 0x7e) && c != '\n' && c != '\r' {
			return false
		}
		// '@' '$' '_' etc. differ between GSM 03.38 and ASCII positions but
		// IA5 carries real ASCII, so any printable ASCII byte is fine.
	}
	return true
}

// buildPDUs turns a job into the submit_sm PDUs for conn according to its
// multipart_mode. The returned count is the number of PDUs (and therefore
// of expected delivery receipts).
func buildPDUs(job *pipeline.DispatchJob, conn *store.Connection) ([]*pdu.SubmitSM, error) {
	segs, dc, err := encodeText(job.Text, job.Encoding, conn)
	if err != nil {
		return nil, fmt.Errorf("dispatch: encode: %w", err)
	}
	if len(segs) > 255 {
		return nil, fmt.Errorf("dispatch: %d segments", len(segs))
	}
	rd := uint8(pdu.RegDeliveryNone)
	if conn.RequestDLR {
		rd = pdu.RegDeliveryAlways
	}
	base := pdu.SubmitSM{
		SourceAddrTON:      job.SourceTON,
		SourceAddrNPI:      job.SourceNPI,
		SourceAddr:         job.Source,
		DestAddrTON:        phone.TONInternational,
		DestAddrNPI:        phone.NPIE164,
		DestinationAddr:    job.Dest,
		RegisteredDelivery: rd,
		DataCoding:         dc,
	}
	if len(segs) == 1 {
		sm := base
		sm.ShortMessage = segs[0]
		return []*pdu.SubmitSM{&sm}, nil
	}
	mode := conn.MultipartMode
	switch mode {
	case ModePayload:
		var n int
		for _, s := range segs {
			n += len(s)
		}
		payload := make([]byte, 0, n)
		for _, s := range segs {
			payload = append(payload, s...)
		}
		sm := base
		sm.TLVs.SetMessagePayload(payload)
		return []*pdu.SubmitSM{&sm}, nil
	case ModeSAR:
		ref := uint16(rand.IntN(0xFFFF) + 1)
		out := make([]*pdu.SubmitSM, len(segs))
		for i, s := range segs {
			sm := base
			sm.ShortMessage = s
			sm.TLVs = nil
			sm.TLVs.SetSAR(ref, uint8(len(segs)), uint8(i+1))
			out[i] = &sm
		}
		return out, nil
	default: // UDH
		ref := uint8(rand.IntN(0xFF) + 1)
		out := make([]*pdu.SubmitSM, len(segs))
		for i, s := range segs {
			sm := base
			sm.ESMClass |= pdu.ESMClassUDHI
			sm.ShortMessage = append(coding.ConcatUDH8(ref, uint8(len(segs)), uint8(i+1)), s...)
			out[i] = &sm
		}
		return out, nil
	}
}

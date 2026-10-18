// Command smpp-cli is a small SMPP ESME for humans and end-to-end tests: it
// binds to the gateway as a client, submits one message (long and Unicode
// text are split automatically), optionally waits for the delivery receipt,
// and prints a JSON result on stdout.
//
//	smpp-cli -addr 127.0.0.1:2775 -system-id acme01 -password secret \
//	         -from MYBANK -to 919876543210 -text "Your code is 1234" -wait 30s
//
// Flags:
//
//	-addr       gateway address (default 127.0.0.1:2775, env SMPP_ADDR)
//	-system-id  SMPP system_id (env SMPP_SYSTEM_ID)
//	-password   SMPP password (env SMPP_PASSWORD)
//	-bind       trx|tx|rx (default trx; receipts need trx or a separate rx)
//	-from, -to  source / destination address
//	-text       message text (UTF-8); -repeat N repeats it N times (long-message tests)
//	-multipart  udh|sar|payload (default udh) for messages longer than one segment
//	-dlr        request a delivery receipt (registered_delivery=1, default true)
//	-wait       how long to wait for the receipt (default 30s, 0 = do not wait)
//	-exit-on-unbind  give up waiting as soon as the gateway closes the session ("unbound": true)
//	-timeout    bind / submit timeout (default 10s)
//
// Exit status: 0 on success (submitted, and receipt received when waited
// for), 1 on a submit / receipt failure, 2 on usage errors.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"os"
	"strings"
	"sync"
	"time"

	"smsgw/engine/internal/smpp/client"
	"smsgw/engine/internal/smpp/coding"
	"smsgw/engine/internal/smpp/pdu"
)

type options struct {
	Addr, SystemID, Password, Bind string
	From, To, Text, Multipart      string
	Repeat                         int
	DLR                            bool
	ExitOnUnbind                   bool
	Wait, Timeout                  time.Duration
}

// Receipt is the parsed delivery receipt in the output.
type Receipt struct {
	ID           string `json:"id"`
	Stat         string `json:"stat"`
	Err          string `json:"err"`
	Dlvrd        int    `json:"dlvrd"`
	SubmitDate   string `json:"submit_date"`
	DoneDate     string `json:"done_date"`
	Text         string `json:"text"`
	MessageState string `json:"message_state,omitempty"`
	Raw          string `json:"raw"`
	ReceivedAt   string `json:"received_at"`
}

// Result is printed as JSON.
type Result struct {
	OK           bool     `json:"ok"`
	Bound        bool     `json:"bound"`
	SystemID     string   `json:"system_id"`
	MessageID    string   `json:"message_id,omitempty"`
	PartIDs      []string `json:"part_ids,omitempty"`
	SubmitStatus string   `json:"submit_status,omitempty"`
	Encoding     string   `json:"encoding,omitempty"`
	Parts        int      `json:"parts,omitempty"`
	DLR          *Receipt `json:"dlr"`
	Unbound      bool     `json:"unbound,omitempty"` // -exit-on-unbind: the session was closed while waiting
	ElapsedMS    int64    `json:"elapsed_ms"`
	Error        string   `json:"error,omitempty"`
}

func envOr(k, def string) string {
	if v, ok := os.LookupEnv(k); ok {
		return v
	}
	return def
}

func parse(args []string, stderr io.Writer) (options, error) {
	fs := flag.NewFlagSet("smpp-cli", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var o options
	fs.StringVar(&o.Addr, "addr", envOr("SMPP_ADDR", "127.0.0.1:2775"), "gateway SMPP address")
	fs.StringVar(&o.SystemID, "system-id", envOr("SMPP_SYSTEM_ID", ""), "system_id")
	fs.StringVar(&o.Password, "password", envOr("SMPP_PASSWORD", ""), "password")
	fs.StringVar(&o.Bind, "bind", "trx", "bind type: trx|tx|rx")
	fs.StringVar(&o.From, "from", "", "source address")
	fs.StringVar(&o.To, "to", "", "destination address")
	fs.StringVar(&o.Text, "text", "", "message text")
	fs.IntVar(&o.Repeat, "repeat", 1, "repeat the text N times")
	fs.StringVar(&o.Multipart, "multipart", "udh", "multipart mode: udh|sar|payload")
	fs.BoolVar(&o.DLR, "dlr", true, "request a delivery receipt")
	fs.BoolVar(&o.ExitOnUnbind, "exit-on-unbind", false, "stop waiting for the receipt as soon as the gateway closes the session (e.g. kicked)")
	fs.DurationVar(&o.Wait, "wait", 30*time.Second, "wait for the delivery receipt (0 = no wait)")
	fs.DurationVar(&o.Timeout, "timeout", 10*time.Second, "bind / submit timeout")
	if err := fs.Parse(args); err != nil {
		return o, err
	}
	if o.SystemID == "" {
		return o, errors.New("-system-id is required")
	}
	bt := strings.ToLower(o.Bind)
	if bt != "trx" && bt != "tx" && bt != "rx" {
		return o, errors.New("-bind must be trx, tx or rx")
	}
	if bt != "rx" && (o.To == "" || o.From == "" || o.Text == "") {
		return o, errors.New("-from, -to and -text are required")
	}
	switch o.Multipart {
	case "udh", "sar", "payload":
	default:
		return o, errors.New("-multipart must be udh, sar or payload")
	}
	if o.Repeat < 1 {
		o.Repeat = 1
	}
	return o, nil
}

func main() {
	o, err := parse(os.Args[1:], os.Stderr)
	if err != nil {
		if !errors.Is(err, flag.ErrHelp) {
			fmt.Fprintln(os.Stderr, "smpp-cli:", err)
		}
		os.Exit(2)
	}
	res := run(o)
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	_ = enc.Encode(res)
	if !res.OK {
		os.Exit(1)
	}
}

// buildPDUs encodes text as submit_sm PDUs (UDH / SAR / message_payload).
func buildPDUs(o options, text string) ([]*pdu.SubmitSM, coding.Parts, error) {
	parts, err := coding.Prepare(text)
	if err != nil {
		return nil, parts, err
	}
	srcTON, srcNPI := uint8(5), uint8(0)
	digits := strings.TrimPrefix(o.From, "+")
	if digits != "" && strings.Trim(digits, "0123456789") == "" {
		srcTON, srcNPI = 1, 1
		if len(digits) <= 8 {
			srcTON, srcNPI = 3, 0
		}
	}
	rd := uint8(0)
	if o.DLR {
		rd = pdu.RegDeliveryAlways
	}
	base := pdu.SubmitSM{SourceAddrTON: srcTON, SourceAddrNPI: srcNPI, SourceAddr: o.From,
		DestAddrTON: 1, DestAddrNPI: 1, DestinationAddr: strings.TrimPrefix(o.To, "+"),
		RegisteredDelivery: rd, DataCoding: parts.DataCoding}
	segs := parts.Segments
	if len(segs) == 1 {
		sm := base
		sm.ShortMessage = segs[0]
		return []*pdu.SubmitSM{&sm}, parts, nil
	}
	switch o.Multipart {
	case "payload":
		sm := base
		sm.TLVs.SetMessagePayload(parts.Payload())
		return []*pdu.SubmitSM{&sm}, parts, nil
	case "sar":
		ref := uint16(rand.IntN(0xFFFF) + 1)
		out := make([]*pdu.SubmitSM, len(segs))
		for i, s := range segs {
			sm := base
			sm.ShortMessage = s
			sm.TLVs = nil
			sm.TLVs.SetSAR(ref, uint8(len(segs)), uint8(i+1))
			out[i] = &sm
		}
		return out, parts, nil
	default:
		ref := uint8(rand.IntN(0xFF) + 1)
		out := make([]*pdu.SubmitSM, len(segs))
		for i, b := range parts.WithUDH(ref) {
			sm := base
			sm.ESMClass = pdu.ESMClassUDHI
			sm.ShortMessage = b
			out[i] = &sm
		}
		return out, parts, nil
	}
}

func run(o options) Result {
	start := time.Now()
	res := Result{SystemID: o.SystemID}
	defer func() { res.ElapsedMS = time.Since(start).Milliseconds() }()
	bt, _ := pdu.ParseBindType(o.Bind)

	var (
		mu       sync.Mutex
		want     string
		got      = make(chan Receipt, 16)
		received []Receipt
	)
	onDeliver := func(d *pdu.DeliverSM) pdu.CommandStatus {
		r, ok := pdu.ReceiptFromDeliverSM(d)
		if !ok {
			return pdu.ESME_ROK
		}
		rc := Receipt{ID: r.ID, Stat: r.Stat, Err: r.Err, Dlvrd: r.Dlvrd, SubmitDate: r.SubmitDateRaw, DoneDate: r.DoneDateRaw,
			Text: r.Text, Raw: string(d.Payload()), ReceivedAt: time.Now().UTC().Format(time.RFC3339Nano)}
		if st, ok := d.TLVs.MessageState(); ok {
			rc.MessageState = st.Stat()
		}
		mu.Lock()
		received = append(received, rc)
		mu.Unlock()
		select {
		case got <- rc:
		default:
		}
		return pdu.ESME_ROK
	}
	c, err := client.New(client.Config{
		Addr: o.Addr, SystemID: o.SystemID, Password: o.Password, BindType: bt,
		BindTimeout: o.Timeout, RequestTimeout: o.Timeout, OnDeliver: onDeliver,
		ReconnectMin: 200 * time.Millisecond, ReconnectMax: time.Second,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		res.Error = err.Error()
		return res
	}
	defer c.Close()
	bctx, cancel := context.WithTimeout(context.Background(), o.Timeout)
	err = c.WaitBound(bctx)
	cancel()
	if err != nil {
		res.Error = "bind failed: " + c.State().LastError
		return res
	}
	res.Bound = true

	if bt == pdu.BindReceiver {
		// Receive-only: wait for any receipt.
		if o.Wait > 0 {
			select {
			case r := <-got:
				res.DLR = &r
				res.OK = true
			case <-time.After(o.Wait):
				res.Error = "no delivery receipt received"
			}
		} else {
			res.OK = true
		}
		return res
	}

	text := strings.Repeat(o.Text, o.Repeat)
	pdus, parts, err := buildPDUs(o, text)
	if err != nil {
		res.Error = err.Error()
		return res
	}
	res.Encoding = parts.Encoding.String()
	res.Parts = len(parts.Segments)
	for _, sm := range pdus {
		sctx, cancel := context.WithTimeout(context.Background(), o.Timeout)
		resp, err := c.Submit(sctx, sm)
		cancel()
		if err != nil {
			var se *pdu.StatusError
			if errors.As(err, &se) {
				res.SubmitStatus = se.Status.String()
			}
			res.Error = "submit failed: " + err.Error()
			return res
		}
		res.PartIDs = append(res.PartIDs, resp.MessageID)
	}
	res.SubmitStatus = pdu.ESME_ROK.String()
	res.MessageID = res.PartIDs[len(res.PartIDs)-1]
	mu.Lock()
	want = res.MessageID
	for i := range received {
		if received[i].ID == want {
			r := received[i]
			res.DLR = &r
		}
	}
	mu.Unlock()
	if o.Wait <= 0 || !o.DLR || res.DLR != nil {
		res.OK = true
		return res
	}
	deadline := time.After(o.Wait)
	var unbound <-chan time.Time
	if o.ExitOnUnbind {
		tick := time.NewTicker(100 * time.Millisecond)
		defer tick.Stop()
		unbound = tick.C
	}
	for {
		select {
		case r := <-got:
			if r.ID == want {
				res.DLR = &r
				res.OK = true
				return res
			}
		case <-unbound:
			if st := c.State(); !st.Status.Bound() {
				res.Unbound = true
				res.Error = "session closed by the gateway while waiting for the receipt"
				if st.LastError != "" {
					res.Error += ": " + st.LastError
				}
				return res
			}
		case <-deadline:
			res.Error = "no delivery receipt received"
			return res
		}
	}
}

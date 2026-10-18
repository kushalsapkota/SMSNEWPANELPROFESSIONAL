package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"smsgw/engine/internal/smpp/pdu"
	"smsgw/engine/internal/smpp/server"
)

// Config for the simulator.
type Config struct {
	Listen      string        // SMPP listen address
	HTTP        string        // HTTP listen address ("" disables)
	SystemID    string        // required system_id ("" accepts any)
	Password    string        // required password ("" accepts any)
	IDFormat    string        // "hex" or "decimal"
	DLRDelay    time.Duration // delay before sending receipts
	MaxMessages int           // records kept for GET /messages
	TPS         int           // per-session TPS limit (0 = unlimited)
	DLRRetries  int           // attempts when no receiver is bound
	// IgnoreRegisteredDelivery sends receipts even when registered_delivery is 0.
	IgnoreRegisteredDelivery bool
	// AcceptAll disables the …1111 submit-failure rule (that destination is
	// then delivered normally), so a second simulator can act as the healthy
	// failover target in end-to-end tests.
	AcceptAll bool
}

// Record is one received logical message, as reported by GET /messages.
type Record struct {
	Seq                uint64    `json:"seq"`
	ReceivedAt         time.Time `json:"received_at"`
	SystemID           string    `json:"system_id"`
	SessionID          string    `json:"session_id"`
	Source             string    `json:"source"`
	SourceTON          uint8     `json:"source_ton"`
	SourceNPI          uint8     `json:"source_npi"`
	Dest               string    `json:"dest"`
	DestTON            uint8     `json:"dest_ton"`
	DestNPI            uint8     `json:"dest_npi"`
	Text               string    `json:"text"`
	DataCoding         uint8     `json:"data_coding"`
	ESMClass           uint8     `json:"esm_class"`
	RegisteredDelivery uint8     `json:"registered_delivery"`
	Parts              int       `json:"parts"`
	Multipart          string    `json:"multipart"`
	SMSCIDs            []string  `json:"smsc_ids"`
	SubmitStatus       string    `json:"submit_status"`
	DLRStat            string    `json:"dlr_stat"`   // planned receipt stat ("" = none)
	DLRsSent           int       `json:"dlrs_sent"`  // receipts acknowledged by the ESME
	DLRErrors          int       `json:"dlr_errors"` // receipts that could not be delivered
}

// Sim is the fake upstream SMSC.
type Sim struct {
	cfg Config
	log *slog.Logger
	srv *server.Server

	idBase uint64
	idSeq  atomic.Uint64

	mu      sync.Mutex
	records []*Record // ring, oldest first
	seq     uint64

	smppAddr net.Addr
	httpLn   net.Listener
	httpSrv  *http.Server

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// NewSim validates cfg and builds the simulator.
func NewSim(cfg Config, log *slog.Logger) (*Sim, error) {
	switch cfg.IDFormat {
	case "", "hex":
		cfg.IDFormat = "hex"
	case "decimal", "dec":
		cfg.IDFormat = "decimal"
	default:
		return nil, fmt.Errorf("invalid id format %q (hex|decimal)", cfg.IDFormat)
	}
	if cfg.MaxMessages <= 0 {
		cfg.MaxMessages = 1000
	}
	if cfg.DLRRetries <= 0 {
		cfg.DLRRetries = 10
	}
	if log == nil {
		log = slog.Default()
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &Sim{cfg: cfg, log: log, ctx: ctx, cancel: cancel,
		// time-based base keeps ids unique across restarts; masked to fit
		// comfortably in uint64 decimal / 16 hex digits.
		idBase: uint64(time.Now().UnixNano()) & 0x0FFF_FFFF_FFFF_FFFF}
	srv, err := server.New(server.Config{
		Authenticator:     server.AuthenticatorFunc(s.authenticate),
		Handler:           s,
		SystemID:          "SMSCSIM",
		PerPartMessageIDs: true, // like a real SMSC: one id (and one DLR) per part
		Logger:            log,
		OnIncomplete: func(m server.IncompleteMessage) {
			log.Warn("incomplete multipart expired", "dest", m.DestAddr, "received", m.Received, "total", m.Total)
		},
	})
	if err != nil {
		cancel()
		return nil, err
	}
	s.srv = srv
	return s, nil
}

// Start opens the SMPP and HTTP listeners.
func (s *Sim) Start() error {
	a, err := s.srv.Listen(s.cfg.Listen)
	if err != nil {
		return fmt.Errorf("smpp listen: %w", err)
	}
	s.smppAddr = a
	if s.cfg.HTTP != "" {
		ln, err := net.Listen("tcp", s.cfg.HTTP)
		if err != nil {
			s.srv.Close()
			return fmt.Errorf("http listen: %w", err)
		}
		s.httpLn = ln
		s.httpSrv = &http.Server{Handler: s.routes(), ReadHeaderTimeout: 5 * time.Second}
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			if err := s.httpSrv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
				s.log.Error("http server", "err", err)
			}
		}()
	}
	s.log.Info("smsc-sim listening", "smpp", a.String(), "http", s.HTTPAddr())
	return nil
}

// SMPPAddr is the bound SMPP address.
func (s *Sim) SMPPAddr() string { return s.smppAddr.String() }

// HTTPAddr is the bound HTTP address ("" if disabled).
func (s *Sim) HTTPAddr() string {
	if s.httpLn == nil {
		return ""
	}
	return s.httpLn.Addr().String()
}

// Close stops everything, including pending receipts.
func (s *Sim) Close() {
	s.cancel()
	if s.httpSrv != nil {
		ctx, c := context.WithTimeout(context.Background(), 2*time.Second)
		_ = s.httpSrv.Shutdown(ctx)
		c()
	}
	s.srv.Close()
	s.wg.Wait()
}

func (s *Sim) authenticate(ctx context.Context, r *server.BindRequest) (*server.Identity, pdu.CommandStatus) {
	if s.cfg.SystemID != "" && r.SystemID != s.cfg.SystemID {
		return nil, pdu.ESME_RINVSYSID
	}
	if s.cfg.Password != "" && r.Password != s.cfg.Password {
		return nil, pdu.ESME_RINVPASWD
	}
	return &server.Identity{OrgID: "sim", SystemID: r.SystemID, TPS: s.cfg.TPS}, pdu.ESME_ROK
}

// NewMessageID implements server.Handler.
func (s *Sim) NewMessageID() string {
	v := s.idBase + s.idSeq.Add(1)
	if s.cfg.IDFormat == "decimal" {
		return strconv.FormatUint(v, 10)
	}
	return strconv.FormatUint(v, 16)
}

// outcome applies the destination rules.
func outcome(dest string, acceptAll bool) (status pdu.CommandStatus, stat string) {
	switch {
	case strings.HasSuffix(dest, "1111") && !acceptAll:
		return pdu.ESME_RSUBMITFAIL, ""
	case strings.HasSuffix(dest, "0000"):
		return pdu.ESME_ROK, "UNDELIV"
	case strings.HasSuffix(dest, "2222"):
		return pdu.ESME_ROK, ""
	}
	return pdu.ESME_ROK, "DELIVRD"
}

// HandleMessage implements server.Handler.
func (s *Sim) HandleMessage(ctx context.Context, m *server.Message) pdu.CommandStatus {
	st, stat := outcome(m.DestAddr, s.cfg.AcceptAll)
	rd := m.RegisteredDelivery & pdu.RegDeliveryMask
	wantDLR := stat != "" && (s.cfg.IgnoreRegisteredDelivery || rd == pdu.RegDeliveryAlways ||
		(rd == pdu.RegDeliveryOnFailure && stat != "DELIVRD"))
	rec := &Record{
		ReceivedAt: m.ReceivedAt, SystemID: m.Session.SystemID, SessionID: m.Session.ID,
		Source: m.SourceAddr, SourceTON: m.SourceTON, SourceNPI: m.SourceNPI,
		Dest: m.DestAddr, DestTON: m.DestTON, DestNPI: m.DestNPI,
		Text: m.Text, DataCoding: m.DataCoding, ESMClass: m.ESMClass, RegisteredDelivery: m.RegisteredDelivery,
		Parts: m.Parts, Multipart: string(m.Multipart), SMSCIDs: append([]string(nil), m.PartIDs...),
		SubmitStatus: st.String(),
	}
	if wantDLR {
		rec.DLRStat = stat
	}
	s.store(rec)
	s.log.Info("message received", "system_id", rec.SystemID, "src", rec.Source, "dst", rec.Dest, "parts", rec.Parts,
		"smsc_ids", strings.Join(rec.SMSCIDs, ","), "status", rec.SubmitStatus, "dlr", rec.DLRStat)
	if st != pdu.ESME_ROK || !wantDLR {
		return st
	}
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		s.sendReceipts(m, rec, stat)
	}()
	return st
}

func (s *Sim) store(r *Record) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.seq++
	r.Seq = s.seq
	s.records = append(s.records, r)
	if over := len(s.records) - s.cfg.MaxMessages; over > 0 {
		s.records = append([]*Record(nil), s.records[over:]...)
	}
}

func (s *Sim) sendReceipts(m *server.Message, rec *Record, stat string) {
	t := time.NewTimer(s.cfg.DLRDelay)
	defer t.Stop()
	select {
	case <-t.C:
	case <-s.ctx.Done():
		return
	}
	submitted := m.ReceivedAt
	done := time.Now()
	state, _ := pdu.MessageStateFromStat(stat)
	errCode := "000"
	if stat != "DELIVRD" {
		errCode = "001"
	}
	dlvrd := 0
	if stat == "DELIVRD" {
		dlvrd = 1
	}
	text := m.Text
	for _, id := range m.PartIDs {
		r := pdu.Receipt{ID: id, Sub: 1, Dlvrd: dlvrd, SubmitDate: submitted, DoneDate: done, Stat: stat, Err: errCode, Text: text}
		d := &pdu.DeliverSM{
			SourceAddrTON: m.DestTON, SourceAddrNPI: m.DestNPI, SourceAddr: m.DestAddr,
			DestAddrTON: m.SourceTON, DestAddrNPI: m.SourceNPI, DestinationAddr: m.SourceAddr,
			ESMClass: pdu.ESMClassMCDeliveryRcpt, DataCoding: 0, ShortMessage: receiptBytes(r.Format()),
		}
		d.TLVs.SetReceiptedMessageID(id)
		d.TLVs.SetMessageState(state)
		if stat != "DELIVRD" {
			d.TLVs.SetNetworkErrorCode(pdu.NetworkErrorCode{Type: pdu.NetworkGSM, Code: 1})
		}
		ok := s.deliverWithRetry(m.Session.SystemID, d)
		s.mu.Lock()
		if ok {
			rec.DLRsSent++
		} else {
			rec.DLRErrors++
		}
		s.mu.Unlock()
	}
}

// receiptBytes keeps the receipt within short_message limits (ASCII text).
func receiptBytes(s string) []byte {
	b := []byte(s)
	if len(b) > pdu.MaxShortMessageLen {
		b = b[:pdu.MaxShortMessageLen]
	}
	return b
}

func (s *Sim) deliverWithRetry(systemID string, d *pdu.DeliverSM) bool {
	for attempt := 1; attempt <= s.cfg.DLRRetries; attempt++ {
		ctx, cancel := context.WithTimeout(s.ctx, 10*time.Second)
		_, err := s.srv.Deliver(ctx, systemID, d)
		cancel()
		if err == nil {
			return true
		}
		var se *pdu.StatusError
		if errors.As(err, &se) && se.Status != pdu.ESME_RX_T_APPN && se.Status != pdu.ESME_RTHROTTLED && se.Status != pdu.ESME_RMSGQFUL {
			s.log.Warn("receipt rejected permanently", "system_id", systemID, "status", se.Status.String())
			return false
		}
		s.log.Debug("receipt delivery failed, retrying", "system_id", systemID, "attempt", attempt, "err", err)
		t := time.NewTimer(time.Second)
		select {
		case <-t.C:
		case <-s.ctx.Done():
			t.Stop()
			return false
		}
	}
	s.log.Warn("receipt dropped after retries", "system_id", systemID)
	return false
}

// Messages returns the stored records, newest first.
func (s *Sim) Messages() []Record {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Record, 0, len(s.records))
	for i := len(s.records) - 1; i >= 0; i-- {
		out = append(out, *s.records[i])
	}
	return out
}

func (s *Sim) routes() http.Handler {
	mux := http.NewServeMux()
	writeJSON := func(w http.ResponseWriter, code int, v any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(code)
		_ = json.NewEncoder(w).Encode(v)
	}
	mux.HandleFunc("GET /messages", func(w http.ResponseWriter, r *http.Request) {
		msgs := s.Messages()
		if lim, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && lim >= 0 && lim < len(msgs) {
			msgs = msgs[:lim]
		}
		if dest := r.URL.Query().Get("dest"); dest != "" {
			filtered := msgs[:0:0]
			for _, m := range msgs {
				if m.Dest == dest {
					filtered = append(filtered, m)
				}
			}
			msgs = filtered
		}
		writeJSON(w, http.StatusOK, map[string]any{"messages": msgs, "count": len(msgs)})
	})
	mux.HandleFunc("DELETE /messages", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		n := len(s.records)
		s.records = nil
		s.mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]any{"deleted": n})
	})
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "sessions": len(s.srv.Sessions())})
	})
	mux.HandleFunc("GET /sessions", func(w http.ResponseWriter, r *http.Request) {
		type sess struct {
			ID         string    `json:"session_id"`
			SystemID   string    `json:"system_id"`
			BindType   string    `json:"bind_type"`
			RemoteAddr string    `json:"remote_addr"`
			BoundSince time.Time `json:"bound_since"`
			Submitted  uint64    `json:"submitted_total"`
		}
		var out []sess
		for _, i := range s.srv.Sessions() {
			out = append(out, sess{i.ID, i.SystemID, i.BindType.String(), i.RemoteAddr, i.BoundSince, i.SubmittedTotal})
		}
		writeJSON(w, http.StatusOK, map[string]any{"sessions": out})
	})
	return mux
}

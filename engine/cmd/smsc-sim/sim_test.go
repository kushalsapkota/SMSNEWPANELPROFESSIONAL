package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"smsgw/engine/internal/smpp/client"
	"smsgw/engine/internal/smpp/coding"
	"smsgw/engine/internal/smpp/pdu"
)

var quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

func startSim(t *testing.T, cfg Config) *Sim {
	t.Helper()
	cfg.Listen = "127.0.0.1:0"
	cfg.HTTP = "127.0.0.1:0"
	s, err := NewSim(cfg, quiet)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	return s
}

func dial(t *testing.T, s *Sim, sys, pw string, onDeliver client.DeliverFunc) *client.Client {
	t.Helper()
	c, err := client.New(client.Config{Addr: s.SMPPAddr(), SystemID: sys, Password: pw, BindType: pdu.BindTransceiver,
		OnDeliver: onDeliver, Logger: quiet, EnquireLinkInterval: -1, ReconnectMin: 20 * time.Millisecond, ReconnectMax: 100 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}

func bound(t *testing.T, c *client.Client) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := c.WaitBound(ctx); err != nil {
		t.Fatalf("bind: %v %+v", err, c.State())
	}
}

func sm(dst, text string) *pdu.SubmitSM {
	b, _ := coding.EncodeGSM7(text)
	return &pdu.SubmitSM{SourceAddrTON: 5, SourceAddr: "MYBANK", DestAddrTON: 1, DestAddrNPI: 1, DestinationAddr: dst, RegisteredDelivery: 1, ShortMessage: b}
}

func getMessages(t *testing.T, s *Sim) []Record {
	t.Helper()
	resp, err := http.Get("http://" + s.HTTPAddr() + "/messages")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out struct {
		Messages []Record `json:"messages"`
		Count    int      `json:"count"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.Count != len(out.Messages) {
		t.Fatal("count mismatch")
	}
	return out.Messages
}

func TestRulesAndReceipts(t *testing.T) {
	s := startSim(t, Config{DLRDelay: 50 * time.Millisecond, IDFormat: "hex"})
	receipts := make(chan pdu.Receipt, 10)
	c := dial(t, s, "gw", "pw", func(d *pdu.DeliverSM) pdu.CommandStatus {
		r, ok := pdu.ReceiptFromDeliverSM(d)
		if !ok {
			t.Errorf("not a receipt: %q", d.ShortMessage)
		}
		if d.DestinationAddr != "MYBANK" || d.SourceAddr == "" {
			t.Errorf("addresses not swapped: %+v", d)
		}
		receipts <- r
		return pdu.ESME_ROK
	})
	bound(t, c)
	ctx := context.Background()

	ok, err := c.Submit(ctx, sm("919876543210", "hello"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := strconv.ParseUint(ok.MessageID, 16, 64); err != nil {
		t.Fatalf("id not hex: %q", ok.MessageID)
	}
	undeliv, err := c.Submit(ctx, sm("919800000000", "fail me"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = c.Submit(ctx, sm("919811111111", "reject"))
	var se *pdu.StatusError
	if !errors.As(err, &se) || se.Status != 0x45 {
		t.Fatalf("1111 rule: %v", err)
	}
	if _, err := c.Submit(ctx, sm("919822222222", "silent")); err != nil {
		t.Fatal(err)
	}
	// registered_delivery 0 -> no receipt
	nodlr := sm("919833333333", "no dlr wanted")
	nodlr.RegisteredDelivery = 0
	if _, err := c.Submit(ctx, nodlr); err != nil {
		t.Fatal(err)
	}

	got := map[string]pdu.Receipt{}
	for i := 0; i < 2; i++ {
		select {
		case r := <-receipts:
			got[r.ID] = r
		case <-time.After(3 * time.Second):
			t.Fatalf("missing receipts, got %v", got)
		}
	}
	if got[ok.MessageID].Stat != "DELIVRD" || got[ok.MessageID].Dlvrd != 1 || got[undeliv.MessageID].Stat != "UNDELIV" || got[undeliv.MessageID].Err != "001" {
		t.Fatalf("%+v", got)
	}
	select {
	case r := <-receipts:
		t.Fatalf("unexpected receipt %+v", r)
	case <-time.After(300 * time.Millisecond):
	}

	msgs := getMessages(t, s)
	if len(msgs) != 5 {
		t.Fatalf("%d messages", len(msgs))
	}
	if msgs[0].Dest != "919833333333" || msgs[4].Text != "hello" || msgs[4].SystemID != "gw" || msgs[4].SMSCIDs[0] != ok.MessageID || msgs[4].DLRsSent != 1 {
		t.Fatalf("%+v", msgs)
	}
	if msgs[2].SubmitStatus != "ESME_RSUBMITFAIL" {
		t.Fatal(msgs[2].SubmitStatus)
	}

	// DELETE clears
	req, _ := http.NewRequest(http.MethodDelete, "http://"+s.HTTPAddr()+"/messages", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != 200 {
		t.Fatal(err)
	}
	resp.Body.Close()
	if n := len(getMessages(t, s)); n != 0 {
		t.Fatal(n)
	}
	resp, err = http.Get("http://" + s.HTTPAddr() + "/health")
	if err != nil {
		t.Fatal(err)
	}
	var h struct {
		OK       bool `json:"ok"`
		Sessions int  `json:"sessions"`
	}
	json.NewDecoder(resp.Body).Decode(&h)
	resp.Body.Close()
	if !h.OK || h.Sessions != 1 {
		t.Fatalf("%+v", h)
	}
}

func TestMultipartPerPartIDsAndDecimal(t *testing.T) {
	s := startSim(t, Config{DLRDelay: 10 * time.Millisecond, IDFormat: "decimal"})
	receipts := make(chan string, 10)
	c := dial(t, s, "gw", "", func(d *pdu.DeliverSM) pdu.CommandStatus {
		id, _ := d.TLVs.ReceiptedMessageID()
		receipts <- id
		return 0
	})
	bound(t, c)
	text := strings.Repeat("multipart text ", 25) // 375 chars -> 3 parts
	p, _ := coding.Prepare(text)
	var ids []string
	for _, m := range p.WithUDH(5) {
		r, err := c.Submit(context.Background(), &pdu.SubmitSM{SourceAddr: "S", DestinationAddr: "15550001234", ESMClass: pdu.ESMClassUDHI, RegisteredDelivery: 1, ShortMessage: m})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := strconv.ParseUint(r.MessageID, 10, 64); err != nil {
			t.Fatalf("not decimal: %q", r.MessageID)
		}
		ids = append(ids, r.MessageID)
	}
	if ids[0] == ids[1] || ids[1] == ids[2] {
		t.Fatalf("ids not per part: %v", ids)
	}
	seen := map[string]bool{}
	for i := 0; i < 3; i++ {
		select {
		case id := <-receipts:
			seen[id] = true
		case <-time.After(3 * time.Second):
			t.Fatal("missing receipts")
		}
	}
	for _, id := range ids {
		if !seen[id] {
			t.Fatalf("no receipt for %s", id)
		}
	}
	msgs := getMessages(t, s)
	if len(msgs) != 1 || msgs[0].Text != text || msgs[0].Parts != 3 || msgs[0].Multipart != "UDH8" || strings.Join(msgs[0].SMSCIDs, ",") != strings.Join(ids, ",") {
		t.Fatalf("%+v", msgs)
	}
}

func TestBindCredentials(t *testing.T) {
	s := startSim(t, Config{SystemID: "gw", Password: "secret"})
	bad := dial(t, s, "gw", "nope", nil)
	time.Sleep(150 * time.Millisecond)
	if st := bad.State(); st.Status.Bound() || !strings.Contains(st.LastError, "ESME_RINVPASWD") {
		t.Fatalf("%+v", st)
	}
	other := dial(t, s, "other", "secret", nil)
	time.Sleep(150 * time.Millisecond)
	if st := other.State(); !strings.Contains(st.LastError, "ESME_RINVSYSID") {
		t.Fatalf("%+v", st)
	}
	good := dial(t, s, "gw", "secret", nil)
	bound(t, good)
}

func TestReceiptRetryUntilReceiverBinds(t *testing.T) {
	s := startSim(t, Config{DLRDelay: 10 * time.Millisecond})
	// submit over a TX-only bind, receipts must wait for an RX bind
	tx, err := client.New(client.Config{Addr: s.SMPPAddr(), SystemID: "gw", BindType: pdu.BindTransmitter, Logger: quiet, EnquireLinkInterval: -1})
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Close()
	bound(t, tx)
	if _, err := tx.Submit(context.Background(), sm("4912345", "later")); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)
	got := make(chan string, 1)
	rx := dial(t, s, "gw", "", func(d *pdu.DeliverSM) pdu.CommandStatus {
		got <- string(d.ShortMessage)
		return 0
	})
	bound(t, rx)
	select {
	case txt := <-got:
		if !strings.Contains(txt, "stat:DELIVRD") {
			t.Fatal(txt)
		}
	case <-time.After(4 * time.Second):
		t.Fatal("receipt not retried")
	}
}

func TestFlagsAndEnv(t *testing.T) {
	t.Setenv("SMSC_SIM_DLR_DELAY", "250ms")
	t.Setenv("SMSC_SIM_ID_FORMAT", "decimal")
	t.Setenv("SMSC_SIM_TPS", "7")
	cfg, level, err := parseFlags([]string{"-listen", ":9999", "-system-id", "x", "-always-dlr"})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Listen != ":9999" || cfg.HTTP != ":2777" || cfg.DLRDelay != 250*time.Millisecond || cfg.IDFormat != "decimal" ||
		cfg.SystemID != "x" || !cfg.IgnoreRegisteredDelivery || cfg.TPS != 7 || level != "info" {
		t.Fatalf("%+v", cfg)
	}
	if _, err := NewSim(Config{IDFormat: "base64"}, quiet); err == nil {
		t.Fatal("bad id format accepted")
	}
}

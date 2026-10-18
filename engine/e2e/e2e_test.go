package e2e

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"smsgw/engine/internal/smpp/client"
	"smsgw/engine/internal/smpp/coding"
	"smsgw/engine/internal/smpp/pdu"
	"smsgw/engine/internal/smpp/session"
)

type submitResp struct {
	MessageID  string `json:"message_id"`
	Status     string `json:"status"`
	Parts      int    `json:"parts"`
	Encoding   string `json:"encoding"`
	CostMicros int64  `json:"cost_micros"`
	RouteID    string `json:"route_id"`
	SentText   string `json:"sent_text"`
	ErrorCode  string `json:"error_code"`
	Message    string `json:"message"`
}

func submit(t *testing.T, body map[string]any) (int, submitResp) {
	t.Helper()
	if _, ok := body["channel"]; !ok {
		body["channel"] = "HTTP"
	}
	var r submitResp
	st, err := call("POST", "/internal/v1/submit", body, &r)
	if err != nil {
		t.Fatalf("submit: %v", err)
	}
	return st, r
}

func simMessages(t *testing.T, s *sim, dest string, n int) []simRecord {
	t.Helper()
	var recs []simRecord
	waitFor(t, "sim to receive "+dest, 10*time.Second, func() bool {
		var err error
		recs, err = s.messages(dest)
		return err == nil && len(recs) >= n
	})
	return recs
}

// OTP template rewrite → sim gets rewritten text; exact dual debit; DLR →
// CDR DELIVERED → signed webhook; rollups.
func TestHTTPSubmitOTPTemplateDLRAndWebhook(t *testing.T) {
	dumpLogsOnFailure(t)
	cBefore, rBefore := balance(t, w.ids.client), balance(t, w.ids.reseller)
	dest := "9198" + randDigits(8)
	st, r := submit(t, map[string]any{"org_id": w.ids.client, "source": "MYBANK", "destination": "+" + dest[:2] + " " + dest[2:7] + "-" + dest[7:],
		"text": "Your OTP is 849201. Do not share it.", "client_ref": "ref-otp-1"})
	if st != 200 {
		t.Fatalf("submit: %d %+v", st, r)
	}
	if r.Status != "ACCEPTED" || r.Parts != 1 || r.Encoding != "GSM7" || r.CostMicros != rateOTPClient || r.RouteID != w.ids.routeOTP ||
		r.SentText != "Acme: your code is 849201" {
		t.Fatalf("response %+v", r)
	}
	if got := balance(t, w.ids.client); got != cBefore-rateOTPClient {
		t.Fatalf("client balance %d, want %d", got, cBefore-rateOTPClient)
	}
	if got := balance(t, w.ids.reseller); got != rBefore-rateOTPRes {
		t.Fatalf("reseller balance %d, want %d", got, rBefore-rateOTPRes)
	}

	recs := simMessages(t, w.simA, dest, 1)
	if recs[0].Text != "Acme: your code is 849201" || recs[0].Source != "MYBANK" || recs[0].SourceTON != 5 || recs[0].DestTON != 1 || recs[0].RegDelivery != 1 {
		t.Fatalf("sim record %+v", recs[0])
	}

	row := waitCDR(t, r.MessageID, "DELIVERED")
	if row.OrigText != "Your OTP is 849201. Do not share it." || row.SentText != r.SentText || row.OTPExtracted == nil || !*row.OTPExtracted ||
		row.Encoding != "GSM7" || row.Parts != 1 || row.ResellerID != w.ids.reseller || row.ConnectionID != w.ids.connA ||
		row.DLRStat != "DELIVRD" || row.DLRErr != "000" || row.DLRAt == nil || row.SubmittedAt == nil || len(row.SMSCIDs) != 1 ||
		row.SMSCIDs[0] != recs[0].SMSCIDs[0] || *row.ClientCost != rateOTPClient || *row.ResellerCost != rateOTPRes ||
		row.RouteCost == nil || *row.RouteCost != 800 || row.ClientRef != "ref-otp-1" || row.Channel != "HTTP" || row.Country != "IN" {
		t.Fatalf("cdr %+v", row)
	}

	var hooks []hookCall
	waitFor(t, "webhook", 10*time.Second, func() bool { hooks = w.hooks.find(r.MessageID); return len(hooks) > 0 })
	h := hooks[0]
	if !h.ValidSig {
		t.Fatal("webhook signature invalid")
	}
	b := h.Body
	if b["event"] != "dlr" || b["status"] != "DELIVERED" || b["dlr_stat"] != "DELIVRD" || b["dlr_err"] != "000" || b["to"] != dest ||
		b["from"] != "MYBANK" || b["client_ref"] != "ref-otp-1" || b["parts"].(float64) != 1 || b["submitted_at"] == nil || b["done_at"] == nil {
		t.Fatalf("webhook body %v", b)
	}
	// The delivery is logged.
	waitFor(t, "webhook_deliveries row", 5*time.Second, func() bool {
		var n int
		_ = w.pool.QueryRow(context.Background(), `SELECT count(*) FROM webhook_deliveries WHERE message_id = $1 AND status_code = 200`, r.MessageID).Scan(&n)
		return n == 1
	})
	// Hourly rollup counts the delivered message.
	waitFor(t, "rollup", 5*time.Second, func() bool {
		var msgs, delivered, submitted, cost int64
		_ = w.pool.QueryRow(context.Background(), `SELECT coalesce(sum(messages),0), coalesce(sum(delivered),0), coalesce(sum(submitted),0), coalesce(sum(client_cost_micros),0)
			FROM message_stats_hourly WHERE org_id = $1 AND route_id = $2 AND country_iso = 'IN'`, w.ids.client, w.ids.routeOTP).Scan(&msgs, &delivered, &submitted, &cost)
		return msgs >= 1 && delivered == msgs && submitted == msgs && cost == msgs*rateOTPClient
	})
}

func TestTemplateRejectFallbackWhenNoOTP(t *testing.T) {
	dumpLogsOnFailure(t)
	before := balance(t, w.ids.client)
	st, r := submit(t, map[string]any{"org_id": w.ids.client, "source": "MYBANK", "destination": "9198" + randDigits(8), "text": "Hello, no code here"})
	if st != 422 || r.ErrorCode != "OTP_NOT_FOUND" {
		t.Fatalf("got %d %+v", st, r)
	}
	if got := balance(t, w.ids.client); got != before {
		t.Fatalf("balance changed %d -> %d", before, got)
	}
	// Preview shows the same decision.
	var pv map[string]any
	if st, err := call("POST", "/internal/v1/template/preview", map[string]any{"text": "Hello", "route_id": w.ids.routeOTP, "org_id": w.ids.client}, &pv); err != nil || st != 200 {
		t.Fatalf("preview %d %v", st, err)
	}
	if pv["action"] != "REJECT" || pv["output"] != nil || pv["otp"] != nil || pv["template_id"] == nil {
		t.Fatalf("preview %v", pv)
	}
	if st, err := call("POST", "/internal/v1/template/preview", map[string]any{"text": "code 4455 for login", "route_id": w.ids.routeOTP, "org_id": w.ids.client}, &pv); err != nil || st != 200 {
		t.Fatalf("preview %d %v", st, err)
	}
	if pv["action"] != "TEMPLATED" || pv["output"] != "Acme: your code is 4455" || pv["otp"] != "4455" || pv["encoding"] != "GSM7" {
		t.Fatalf("preview %v", pv)
	}
}

func TestMultipartUnicodeUDHAndSAR(t *testing.T) {
	dumpLogsOnFailure(t)
	text := strings.Repeat("Привет, мир! ", 8) // 104 UTF-16 units → 2 parts
	for _, tc := range []struct {
		name, prefix, conn, mode string
		sim                      *sim
	}{
		{"UDH", "44", w.ids.connA, "UDH8", w.simA},
		{"SAR", "33", w.ids.connB, "SAR", w.simB},
	} {
		t.Run(tc.name, func(t *testing.T) {
			before := balance(t, w.ids.client)
			dest := tc.prefix + randDigits(9)
			st, r := submit(t, map[string]any{"org_id": w.ids.client, "source": "447700900123", "destination": dest, "text": text})
			if st != 200 || r.Parts != 2 || r.Encoding != "UCS2" || r.CostMicros != 2*rateMainClient {
				t.Fatalf("submit %d %+v", st, r)
			}
			if got := balance(t, w.ids.client); got != before-2*rateMainClient {
				t.Fatalf("balance %d want %d", got, before-2*rateMainClient)
			}
			recs := simMessages(t, tc.sim, dest, 1)
			rec := recs[0]
			if rec.Text != text || rec.Parts != 2 || rec.Multipart != tc.mode || rec.DataCoding != 8 || rec.SourceTON != 1 || len(rec.SMSCIDs) != 2 {
				t.Fatalf("sim record %+v", rec)
			}
			row := waitCDR(t, r.MessageID, "DELIVERED")
			if len(row.SMSCIDs) != 2 || row.Encoding != "UCS2" || row.Parts != 2 || row.ConnectionID != tc.conn || row.SourceTON != 1 {
				t.Fatalf("cdr %+v", row)
			}
		})
	}
}

// dest …1111 → ESME_RSUBMITFAIL on connection A → failover to B (also
// fails) → FAILED with a full refund and a FAILED webhook.
func TestFailoverThenFailedWithFullRefund(t *testing.T) {
	dumpLogsOnFailure(t)
	cBefore, rBefore := balance(t, w.ids.client), balance(t, w.ids.reseller)
	dest := "44" + randDigits(5) + "1111"
	st, r := submit(t, map[string]any{"org_id": w.ids.client, "source": "MYBANK", "destination": dest, "text": "will fail", "client_ref": "fail-1"})
	if st != 200 {
		t.Fatalf("submit %d %+v", st, r)
	}
	a := simMessages(t, w.simA, dest, 1)
	b := simMessages(t, w.simB, dest, 1)
	if a[0].SubmitStatus != "ESME_RSUBMITFAIL" || b[0].SubmitStatus != "ESME_RSUBMITFAIL" {
		t.Fatalf("sim statuses %s %s", a[0].SubmitStatus, b[0].SubmitStatus)
	}
	row := waitCDR(t, r.MessageID, "FAILED")
	if !row.Refunded || row.ErrorCode != "ESME_RSUBMITFAIL" || row.SubmittedAt != nil {
		t.Fatalf("cdr %+v", row)
	}
	waitFor(t, "full refund", 5*time.Second, func() bool {
		return balance(t, w.ids.client) == cBefore && balance(t, w.ids.reseller) == rBefore
	})
	var hooks []hookCall
	waitFor(t, "FAILED webhook", 10*time.Second, func() bool { hooks = w.hooks.find(r.MessageID); return len(hooks) > 0 })
	if hooks[0].Body["status"] != "FAILED" || !hooks[0].ValidSig || hooks[0].Body["submitted_at"] != nil {
		t.Fatalf("webhook %v", hooks[0].Body)
	}
	// Refunded revenue is not counted in the rollup.
	var failed, cost int64
	waitFor(t, "rollup failed", 5*time.Second, func() bool {
		_ = w.pool.QueryRow(context.Background(), `SELECT coalesce(sum(failed),0), coalesce(sum(client_cost_micros),0) FROM message_stats_hourly
			WHERE org_id = $1 AND route_id = $2`, w.ids.client, w.ids.routeMain).Scan(&failed, &cost)
		return failed >= 1
	})
}

// A route whose first-priority connection is not bound is served by the next one.
func TestUnboundPrimaryConnectionIsSkipped(t *testing.T) {
	dumpLogsOnFailure(t)
	dest := "49" + randDigits(9)
	st, r := submit(t, map[string]any{"org_id": w.ids.client, "source": "MYBANK", "destination": dest, "text": "via secondary"})
	if st != 200 {
		t.Fatalf("submit %d %+v", st, r)
	}
	simMessages(t, w.simA, dest, 1)
	row := waitCDR(t, r.MessageID, "DELIVERED")
	if row.ConnectionID != w.ids.connA {
		t.Fatalf("connection %s", row.ConnectionID)
	}
	if s := connStates()[w.ids.connDown]; s == "BOUND" {
		t.Fatalf("down connection is %s", s)
	}
}

func bindClient(t *testing.T, sys, pw string, onDeliver client.DeliverFunc) (*client.Client, error) {
	t.Helper()
	c, err := client.New(client.Config{Addr: w.app.SMPPAddr(), SystemID: sys, Password: pw, BindType: pdu.BindTransceiver,
		OnDeliver: onDeliver, ReconnectMin: 5 * time.Second, ReconnectMax: 5 * time.Second, EnquireLinkInterval: -1,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := c.WaitBound(ctx); err != nil {
		st := c.State()
		c.Close()
		return nil, &bindErr{st.LastError}
	}
	return c, nil
}

type bindErr struct{ msg string }

func (e *bindErr) Error() string { return "bind failed: " + e.msg }

func TestSMPPClientSubmitAndDeliveryReceipt(t *testing.T) {
	dumpLogsOnFailure(t)
	receipts := make(chan *pdu.DeliverSM, 8)
	c, err := bindClient(t, w.ids.sysID, w.ids.sysPW, func(d *pdu.DeliverSM) pdu.CommandStatus {
		receipts <- d
		return pdu.ESME_ROK
	})
	if err != nil {
		t.Fatalf("bind: %v", err)
	}
	defer c.Close()

	var sess struct {
		Sessions []struct {
			OrgID    string `json:"org_id"`
			SystemID string `json:"system_id"`
			BindType string `json:"bind_type"`
		} `json:"sessions"`
	}
	if st, err := call("GET", "/internal/v1/smpp/sessions", nil, &sess); err != nil || st != 200 {
		t.Fatalf("sessions %d %v", st, err)
	}
	found := false
	for _, s := range sess.Sessions {
		if s.SystemID == w.ids.sysID && s.OrgID == w.ids.client && s.BindType == "TRX" {
			found = true
		}
	}
	if !found {
		t.Fatalf("session not listed: %+v", sess)
	}

	before := balance(t, w.ids.client)
	dest := "44" + randDigits(9)
	msg, _ := coding.EncodeGSM7("Hello from SMPP")
	resp, err := c.Submit(context.Background(), &pdu.SubmitSM{SourceAddrTON: 5, SourceAddr: "ACME", DestAddrTON: 1, DestAddrNPI: 1,
		DestinationAddr: dest, RegisteredDelivery: 1, ShortMessage: msg})
	if err != nil {
		t.Fatalf("submit: %v", err)
	}
	id := resp.MessageID
	if len(id) != 36 {
		t.Fatalf("message id %q", id)
	}
	if got := balance(t, w.ids.client); got != before-rateMainClient {
		t.Fatalf("balance %d want %d", got, before-rateMainClient)
	}
	select {
	case d := <-receipts:
		r, ok := pdu.ReceiptFromDeliverSM(d)
		if !ok || r.ID != id || r.Stat != "DELIVRD" || r.Sub != 1 || r.Dlvrd != 1 || d.ESMClass != pdu.ESMClassMCDeliveryRcpt ||
			!strings.HasPrefix(r.Text, "Hello from SMPP") || d.SourceAddr != dest || d.DestinationAddr != "ACME" {
			t.Fatalf("receipt %+v %q", r, d.Payload())
		}
		if rid, _ := d.TLVs.ReceiptedMessageID(); rid != id {
			t.Fatalf("receipted_message_id %q", rid)
		}
		if st, ok := d.TLVs.MessageState(); !ok || st != pdu.StateDelivered {
			t.Fatalf("message_state %v", st)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("no delivery receipt")
	}
	row := waitCDR(t, id, "DELIVERED")
	if row.Channel != "SMPP" || row.ClientRef != id || row.SentText != "Hello from SMPP" {
		t.Fatalf("cdr %+v", row)
	}

	// Rejections map to SMPP statuses.
	_, err = c.Submit(context.Background(), &pdu.SubmitSM{SourceAddrTON: 5, SourceAddr: "ACME", DestinationAddr: "12", ShortMessage: msg})
	if se, ok := err.(*pdu.StatusError); !ok || se.Status != pdu.ESME_RINVDSTADR {
		t.Fatalf("invalid destination: %v", err)
	}
}

// bindStatus performs one raw bind_transceiver and returns its status.
func bindStatus(t *testing.T, sys, pw string) pdu.CommandStatus {
	t.Helper()
	nc, err := net.DialTimeout("tcp", w.app.SMPPAddr(), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	s := session.New(nc, session.Config{EnquireLinkInterval: -1, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	s.Start()
	defer s.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	resp, err := s.Request(ctx, &pdu.Bind{BindType: pdu.BindTransceiver, SystemID: sys, Password: pw, InterfaceVersion: pdu.InterfaceVersion34})
	if err != nil {
		t.Fatalf("bind request: %v", err)
	}
	return resp.Hdr().Status
}

func TestSMPPBindRejections(t *testing.T) {
	dumpLogsOnFailure(t)
	for _, tc := range []struct {
		name, sys, pw string
		want          pdu.CommandStatus
	}{
		{"bad password", w.ids.sysID, "wrong", pdu.ESME_RINVPASWD},
		{"unknown system_id", "nosuch" + randHex(4), "x", pdu.ESME_RINVSYSID},
		{"suspended org", w.ids.suspSysID, w.ids.sysPW, pdu.ESME_RINVSYSID},
		{"ok", w.ids.sysID, w.ids.sysPW, pdu.ESME_ROK},
	} {
		if got := bindStatus(t, tc.sys, tc.pw); got != tc.want {
			t.Errorf("%s: got %s want %s", tc.name, got, tc.want)
		}
	}
}

func TestSuspendedOrgRejected(t *testing.T) {
	dumpLogsOnFailure(t)
	before := balance(t, w.ids.suspended)
	st, r := submit(t, map[string]any{"org_id": w.ids.suspended, "source": "MYBANK", "destination": "44" + randDigits(9), "text": "hi"})
	if st != 422 || r.ErrorCode != "ACCOUNT_SUSPENDED" {
		t.Fatalf("got %d %+v", st, r)
	}
	if balance(t, w.ids.suspended) != before {
		t.Fatal("suspended org was charged")
	}
}

func TestRateLimit(t *testing.T) {
	dumpLogsOnFailure(t)
	before := balance(t, w.ids.limited)
	var mu sync.Mutex
	codes := map[string]int{}
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			st, r := submit(t, map[string]any{"org_id": w.ids.limited, "source": "MYBANK", "destination": "44" + randDigits(5) + "2222", "text": "burst"})
			mu.Lock()
			defer mu.Unlock()
			switch {
			case st == 200:
				codes["ok"]++
			case st == 429 && r.ErrorCode == "RATE_LIMITED":
				codes["limited"]++
			default:
				codes[r.ErrorCode]++
			}
		}()
	}
	wg.Wait()
	// max_tps 2: at most 2 per one-second window (the burst spans ≤ 2 windows).
	if codes["ok"] < 1 || codes["ok"] > 4 || codes["limited"] < 4 || codes["ok"]+codes["limited"] != 8 {
		t.Fatalf("outcomes %v", codes)
	}
	if got := balance(t, w.ids.limited); got != before-int64(codes["ok"])*rateMainClient {
		var n int
		_ = w.pool.QueryRow(context.Background(), `SELECT count(*) FROM message_logs WHERE org_id = $1`, w.ids.limited).Scan(&n)
		t.Fatalf("balance %d want %d (before %d, outcomes %v, cdrs %d)", got, before-int64(codes["ok"])*rateMainClient, before, codes, n)
	}
}

func TestInsufficientFunds(t *testing.T) {
	st, r := submit(t, map[string]any{"org_id": w.ids.poor, "source": "MYBANK", "destination": "44" + randDigits(9), "text": "hi"})
	if st != 422 || r.ErrorCode != "INSUFFICIENT_FUNDS" {
		t.Fatalf("got %d %+v", st, r)
	}
	if balance(t, w.ids.poor) != 1000 {
		t.Fatal("poor org was charged")
	}
}

// smpp-cli: long Unicode message, waits for its receipt.
func TestSMPPCLILongUnicode(t *testing.T) {
	dumpLogsOnFailure(t)
	dest := "44" + randDigits(9)
	out, err := exec.Command(filepath.Join(w.binDir, "smpp-cli"), "-addr", w.app.SMPPAddr(), "-system-id", w.ids.sysID,
		"-password", w.ids.sysPW, "-from", "ACME", "-to", dest, "-text", "Ünïcödé ✓ ", "-repeat", "9", "-wait", "15s").Output()
	var res struct {
		OK        bool     `json:"ok"`
		MessageID string   `json:"message_id"`
		PartIDs   []string `json:"part_ids"`
		Encoding  string   `json:"encoding"`
		Parts     int      `json:"parts"`
		DLR       *struct {
			ID   string `json:"id"`
			Stat string `json:"stat"`
		} `json:"dlr"`
		Error string `json:"error"`
	}
	if jerr := json.Unmarshal(out, &res); jerr != nil {
		t.Fatalf("smpp-cli output %q (%v / %v)", out, err, jerr)
	}
	if err != nil || !res.OK || res.Encoding != "UCS2" || res.Parts != 2 || len(res.PartIDs) != 2 || res.DLR == nil ||
		res.DLR.ID != res.MessageID || res.DLR.Stat != "DELIVRD" {
		t.Fatalf("smpp-cli: %v %+v", err, res)
	}
	recs := simMessages(t, w.simA, dest, 1)
	if recs[0].Text != strings.Repeat("Ünïcödé ✓ ", 9) || recs[0].Parts != 2 {
		t.Fatalf("sim record %+v", recs[0])
	}
}

func TestBatchAuthHealthStatusMetrics(t *testing.T) {
	dumpLogsOnFailure(t)
	var batch struct {
		Results []map[string]any `json:"results"`
	}
	st, err := call("POST", "/internal/v1/submit/batch", map[string]any{"items": []map[string]any{
		{"org_id": w.ids.client, "channel": "WEB", "source": "MYBANK", "destination": "44" + randDigits(5) + "2222", "text": "batch one"},
		{"org_id": w.ids.client, "channel": "WEB", "source": "MYBANK", "destination": "12", "text": "bad dest"},
		{"org_id": w.ids.client, "channel": "SMPP", "source": "MYBANK", "destination": "4477009001", "text": "bad channel"},
	}}, &batch)
	if err != nil || st != 200 || len(batch.Results) != 3 {
		t.Fatalf("batch %d %v %+v", st, err, batch)
	}
	if batch.Results[0]["status"] != "ACCEPTED" || batch.Results[1]["error_code"] != "INVALID_DESTINATION" || batch.Results[2]["error_code"] != "INVALID_REQUEST" {
		t.Fatalf("batch results %+v", batch.Results)
	}

	req, _ := http.NewRequest("GET", "http://"+w.app.HTTPAddr()+"/internal/v1/health", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var e map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&e)
	resp.Body.Close()
	if resp.StatusCode != 401 || e["error_code"] != "UNAUTHORIZED" {
		t.Fatalf("no token: %d %v", resp.StatusCode, e)
	}

	var h map[string]bool
	if st, err := call("GET", "/internal/v1/health", nil, &h); err != nil || st != 200 || !h["ok"] || !h["db"] || !h["redis"] {
		t.Fatalf("health %d %v %v", st, err, h)
	}

	var cs struct {
		Connections []struct {
			ID             string `json:"connection_id"`
			State          string `json:"state"`
			TPSLimit       int    `json:"tps_limit"`
			SubmittedTotal uint64 `json:"submitted_total"`
			Sessions       []struct {
				State string `json:"state"`
			} `json:"sessions"`
		} `json:"connections"`
	}
	if st, err := call("GET", "/internal/v1/connections/status", nil, &cs); err != nil || st != 200 {
		t.Fatalf("status %d %v", st, err)
	}
	for _, c := range cs.Connections {
		if c.ID == w.ids.connA && (c.State != "BOUND" || len(c.Sessions) != 2 || c.Sessions[0].State != "BOUND_TRX" || c.TPSLimit != 200 || c.SubmittedTotal == 0) {
			t.Fatalf("connA status %+v", c)
		}
	}

	// Credit through the engine (balance loaded → OK, then DUPLICATE).
	before := balance(t, w.ids.client)
	key := "e2e-topup-" + randHex(8)
	var cr struct {
		Status  string `json:"status"`
		Balance *int64 `json:"balance_micros"`
	}
	if st, err := call("POST", "/internal/v1/balance/credit", map[string]any{"org_id": w.ids.client, "delta_micros": 1_000_000, "idempotency_key": key}, &cr); err != nil || st != 200 || cr.Status != "OK" || *cr.Balance != before+1_000_000 {
		t.Fatalf("credit %d %v %+v", st, err, cr)
	}
	if st, _ := call("POST", "/internal/v1/balance/credit", map[string]any{"org_id": w.ids.client, "delta_micros": 1_000_000, "idempotency_key": key}, &cr); st != 200 || cr.Status != "DUPLICATE" {
		t.Fatalf("duplicate credit %d %+v", st, cr)
	}

	resp, err = http.Get("http://" + w.app.MetricsAddr() + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	for _, want := range []string{`smsgw_submit_total{channel="HTTP",result="accepted"}`, "smsgw_upstream_connection_up{", "smsgw_dlr_received_total{stat=\"DELIVRD\"}", "smsgw_tps_in "} {
		if !strings.Contains(string(b), want) {
			t.Fatalf("metrics missing %q", want)
		}
	}
}

// Balances are written back to accounts_balance by the syncer.
func TestBalanceSyncedToPostgres(t *testing.T) {
	waitFor(t, "balance sync", 10*time.Second, func() bool {
		var pg int64
		_ = w.pool.QueryRow(context.Background(), `SELECT balance_micros FROM accounts_balance WHERE org_id = $1`, w.ids.client).Scan(&pg)
		return pg == balance(t, w.ids.client)
	})
}

// UNDELIV receipts are final but not refunded (CONTRACTS §8).
func TestUndeliveredIsNotRefunded(t *testing.T) {
	dumpLogsOnFailure(t)
	before := balance(t, w.ids.client)
	dest := "44" + randDigits(5) + "0000"
	st, r := submit(t, map[string]any{"org_id": w.ids.client, "source": "MYBANK", "destination": dest, "text": "to a dead phone"})
	if st != 200 {
		t.Fatalf("submit %d %+v", st, r)
	}
	row := waitCDR(t, r.MessageID, "UNDELIVERED")
	if row.Refunded || row.DLRStat != "UNDELIV" || row.DLRErr != "001" {
		t.Fatalf("cdr %+v", row)
	}
	time.Sleep(200 * time.Millisecond)
	if got := balance(t, w.ids.client); got != before-rateMainClient {
		t.Fatalf("balance %d want %d", got, before-rateMainClient)
	}
	var hooks []hookCall
	waitFor(t, "webhook", 10*time.Second, func() bool { hooks = w.hooks.find(r.MessageID); return len(hooks) > 0 })
	if hooks[0].Body["status"] != "UNDELIVERED" || hooks[0].Body["dlr_stat"] != "UNDELIV" {
		t.Fatalf("webhook %v", hooks[0].Body)
	}
}

// POST /smpp/sessions/kick unbinds; suspending the org (DB write +
// cfg:invalidate) unbinds live sessions and rejects new binds.
func TestKickAndSuspensionUnbind(t *testing.T) {
	dumpLogsOnFailure(t)
	c1, err := bindClient(t, w.ids.kickSysID, w.ids.sysPW, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c1.Close()
	var k struct {
		Kicked int `json:"kicked"`
	}
	if st, err := call("POST", "/internal/v1/smpp/sessions/kick", map[string]any{"org_id": w.ids.kickOrg}, &k); err != nil || st != 200 || k.Kicked != 1 {
		t.Fatalf("kick %d %v %+v", st, err, k)
	}
	waitFor(t, "kicked session down", 5*time.Second, func() bool { return !c1.State().Status.Bound() })

	c2, err := bindClient(t, w.ids.kickSysID, w.ids.sysPW, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c2.Close()
	ctx := context.Background()
	if _, err := w.pool.Exec(ctx, `UPDATE organizations SET smpp_enabled = false WHERE id = $1`, w.ids.kickOrg); err != nil {
		t.Fatal(err)
	}
	opt, _ := redis.ParseURL(w.redisURL)
	rdb := redis.NewClient(opt)
	t.Cleanup(func() { rdb.Close() })
	t.Cleanup(func() { // restore for repeated runs (-count)
		_, _ = w.pool.Exec(ctx, `UPDATE organizations SET smpp_enabled = true WHERE id = $1`, w.ids.kickOrg)
		_ = rdb.Publish(ctx, w.invalidate, `{"entity":"organizations"}`).Err()
		waitFor(t, "SMPP re-enabled", 10*time.Second, func() bool { return bindStatus(t, w.ids.kickSysID, w.ids.sysPW) == pdu.ESME_ROK })
		time.Sleep(300 * time.Millisecond) // let the sweeper see the fresh snapshot
	})
	if err := rdb.Publish(ctx, w.invalidate, `{"entity":"organizations","id":"`+w.ids.kickOrg+`"}`).Err(); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "session unbound after SMPP disabled", 10*time.Second, func() bool { return !c2.State().Status.Bound() })
	if got := bindStatus(t, w.ids.kickSysID, w.ids.sysPW); got != pdu.ESME_RINVSYSID {
		t.Fatalf("bind after disable: %s", got)
	}
}

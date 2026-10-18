// Command smsc-sim is a fake upstream SMSC for tests and end-to-end runs.
//
// It accepts SMPP binds, answers submit_sm with unique message ids and, after
// -dlr-delay, sends deliver_sm delivery receipts (one per part). Destination
// rules:
//
//	…0000  → receipt stat UNDELIV
//	…1111  → submit_sm_resp ESME_RSUBMITFAIL (0x45), no receipt
//	…2222  → accepted, never a receipt
//	other  → receipt stat DELIVRD
//
// Receipts honour registered_delivery (1 = always, 2 = failures only) unless
// -always-dlr is set. Multipart messages (UDH 8/16-bit, SAR) are reassembled
// for the log.
//
// HTTP (-http, default :2777): GET /messages[?limit=&dest=] (newest first),
// DELETE /messages, GET /health, GET /sessions.
//
// Every flag can also be set by environment variable (flag wins):
//
//	-listen      SMSC_SIM_LISTEN       (default :2776)
//	-http        SMSC_SIM_HTTP         (default :2777, "" disables)
//	-system-id   SMSC_SIM_SYSTEM_ID    (default "" = accept any)
//	-password    SMSC_SIM_PASSWORD     (default "" = accept any)
//	-id-format   SMSC_SIM_ID_FORMAT    hex|decimal (default hex)
//	-dlr-delay   SMSC_SIM_DLR_DELAY    Go duration (default 1s)
//	-max-messages SMSC_SIM_MAX_MESSAGES (default 1000)
//	-tps         SMSC_SIM_TPS          per-session limit, 0 = unlimited
//	-always-dlr  SMSC_SIM_ALWAYS_DLR   ignore registered_delivery
//	-accept-all  SMSC_SIM_ACCEPT_ALL   disable the …1111 rejection rule (failover target)
//	-log-level   SMSC_SIM_LOG_LEVEL    debug|info|warn|error (default info)
package main

import (
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"
)

func envStr(key, def string) string {
	if v, ok := os.LookupEnv(key); ok {
		return v
	}
	return def
}

func envDur(key string, def time.Duration) time.Duration {
	if v, ok := os.LookupEnv(key); ok {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
		fmt.Fprintf(os.Stderr, "smsc-sim: ignoring invalid %s=%q\n", key, v)
	}
	return def
}

func envInt(key string, def int) int {
	if v, ok := os.LookupEnv(key); ok {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
		fmt.Fprintf(os.Stderr, "smsc-sim: ignoring invalid %s=%q\n", key, v)
	}
	return def
}

func envBool(key string, def bool) bool {
	if v, ok := os.LookupEnv(key); ok {
		if b, err := strconv.ParseBool(v); err == nil {
			return b
		}
	}
	return def
}

func parseFlags(args []string) (Config, string, error) {
	fs := flag.NewFlagSet("smsc-sim", flag.ContinueOnError)
	var c Config
	fs.StringVar(&c.Listen, "listen", envStr("SMSC_SIM_LISTEN", ":2776"), "SMPP listen address")
	fs.StringVar(&c.HTTP, "http", envStr("SMSC_SIM_HTTP", ":2777"), "HTTP listen address (empty disables)")
	fs.StringVar(&c.SystemID, "system-id", envStr("SMSC_SIM_SYSTEM_ID", ""), "required bind system_id (empty accepts any)")
	fs.StringVar(&c.Password, "password", envStr("SMSC_SIM_PASSWORD", ""), "required bind password (empty accepts any)")
	fs.StringVar(&c.IDFormat, "id-format", envStr("SMSC_SIM_ID_FORMAT", "hex"), "message id format: hex|decimal")
	fs.DurationVar(&c.DLRDelay, "dlr-delay", envDur("SMSC_SIM_DLR_DELAY", time.Second), "delay before sending delivery receipts")
	fs.IntVar(&c.MaxMessages, "max-messages", envInt("SMSC_SIM_MAX_MESSAGES", 1000), "messages kept for GET /messages")
	fs.IntVar(&c.TPS, "tps", envInt("SMSC_SIM_TPS", 0), "per-session TPS limit (0 = unlimited)")
	fs.BoolVar(&c.IgnoreRegisteredDelivery, "always-dlr", envBool("SMSC_SIM_ALWAYS_DLR", false), "send receipts even if registered_delivery is 0")
	fs.BoolVar(&c.AcceptAll, "accept-all", envBool("SMSC_SIM_ACCEPT_ALL", false), "deliver …1111 destinations instead of rejecting them")
	level := fs.String("log-level", envStr("SMSC_SIM_LOG_LEVEL", "info"), "log level: debug|info|warn|error")
	if err := fs.Parse(args); err != nil {
		return c, "", err
	}
	return c, *level, nil
}

func main() {
	cfg, level, err := parseFlags(os.Args[1:])
	if err != nil {
		os.Exit(2)
	}
	var lv slog.Level
	if err := lv.UnmarshalText([]byte(level)); err != nil {
		fmt.Fprintf(os.Stderr, "smsc-sim: invalid log level %q\n", level)
		os.Exit(2)
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: lv}))
	sim, err := NewSim(cfg, log)
	if err != nil {
		log.Error("config", "err", err)
		os.Exit(2)
	}
	if err := sim.Start(); err != nil {
		log.Error("start", "err", err)
		os.Exit(1)
	}
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	log.Info("shutting down")
	sim.Close()
}

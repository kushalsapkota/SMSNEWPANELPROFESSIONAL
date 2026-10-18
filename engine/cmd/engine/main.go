// Command engine runs the SMS gateway engine: client SMPP server (:2775),
// internal HTTP API (:8081), Prometheus metrics (:9100), upstream SMPP
// dispatch, DLR processing, webhooks, CDR writing and balance syncing.
//
// Configuration is read from the environment (see internal/config):
// DATABASE_URL, REDIS_URL, INTERNAL_TOKEN and APP_ENC_KEY are required.
// SIGINT / SIGTERM trigger a graceful shutdown (ENGINE_SHUTDOWN_TIMEOUT).
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"smsgw/engine/internal/app"
	"smsgw/engine/internal/config"
)

func newLogger(level, format string) *slog.Logger {
	var lv slog.Level
	_ = lv.UnmarshalText([]byte(level))
	opts := &slog.HandlerOptions{Level: lv}
	if format == "text" {
		return slog.New(slog.NewTextHandler(os.Stderr, opts))
	}
	return slog.New(slog.NewJSONHandler(os.Stderr, opts))
}

func main() {
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	log := newLogger(cfg.LogLevel, cfg.LogFormat)
	slog.SetDefault(log)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	startCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	a, err := app.New(startCtx, cfg, log, app.Overrides{})
	cancel()
	if err != nil {
		log.Error("engine failed to start", "err", err)
		os.Exit(1)
	}
	if err := a.Run(ctx); err != nil {
		log.Error("engine stopped with error", "err", err)
		os.Exit(1)
	}
}

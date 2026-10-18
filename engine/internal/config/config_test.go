package config

import (
	"encoding/base64"
	"errors"
	"strings"
	"testing"
	"time"
)

func env(m map[string]string) Getenv {
	return func(k string) (string, bool) { v, ok := m[k]; return v, ok }
}

func base() map[string]string {
	return map[string]string{
		"DATABASE_URL":   "postgres://sms_engine_login:sms_engine_dev@localhost:5432/sms_core",
		"REDIS_URL":      "redis://localhost:6399/1",
		"INTERNAL_TOKEN": "0123456789abcdef-token",
		"APP_ENC_KEY":    base64.StdEncoding.EncodeToString(make([]byte, 32)),
	}
}

func TestDefaults(t *testing.T) {
	c, err := LoadFrom(env(base()))
	if err != nil {
		t.Fatal(err)
	}
	if c.HTTPAddr != ":8081" || c.SMPPAddr != ":2775" || c.MetricsAddr != ":9100" {
		t.Errorf("addrs: %s %s %s", c.HTTPAddr, c.SMPPAddr, c.MetricsAddr)
	}
	if c.ConfigReloadInterval != 60*time.Second || c.ConfigDebounce != 200*time.Millisecond {
		t.Errorf("reload: %v %v", c.ConfigReloadInterval, c.ConfigDebounce)
	}
	if c.BindCacheTTL != 10*time.Minute || c.DebitTxnTTL != 72*time.Hour {
		t.Errorf("ttl: %v %v", c.BindCacheTTL, c.DebitTxnTTL)
	}
	if len(c.AppEncKey) != 32 || c.InstanceID == "" || c.LogLevel != "info" {
		t.Errorf("misc: %d %q %q", len(c.AppEncKey), c.InstanceID, c.LogLevel)
	}
}

func TestOverrides(t *testing.T) {
	m := base()
	m["ENGINE_HTTP_ADDR"] = "127.0.0.1:9999"
	m["ENGINE_CONFIG_RELOAD_INTERVAL"] = "30"
	m["ENGINE_CONFIG_DEBOUNCE"] = "50ms"
	m["ENGINE_DB_MAX_CONNS"] = "7"
	m["LOG_LEVEL"] = "DEBUG"
	m["ENGINE_INSTANCE_ID"] = "eng-a"
	c, err := LoadFrom(env(m))
	if err != nil {
		t.Fatal(err)
	}
	if c.HTTPAddr != "127.0.0.1:9999" || c.ConfigReloadInterval != 30*time.Second ||
		c.ConfigDebounce != 50*time.Millisecond || c.DBMaxConns != 7 || c.LogLevel != "debug" || c.InstanceID != "eng-a" {
		t.Errorf("%+v", c)
	}
}

func TestValidationCollectsAll(t *testing.T) {
	m := map[string]string{
		"DATABASE_URL":                  "mysql://x",
		"INTERNAL_TOKEN":                "short",
		"APP_ENC_KEY":                   base64.StdEncoding.EncodeToString(make([]byte, 16)),
		"ENGINE_HTTP_ADDR":              "nope",
		"ENGINE_DB_MAX_CONNS":           "abc",
		"ENGINE_CONFIG_RELOAD_INTERVAL": "10ms",
		"LOG_LEVEL":                     "loud",
		"ENGINE_DB_MIN_CONNS":           "50",
	}
	_, err := LoadFrom(env(m))
	var ve *ValidationError
	if !errors.As(err, &ve) || !IsValidation(err) {
		t.Fatalf("expected ValidationError, got %v", err)
	}
	for _, v := range []string{"DATABASE_URL", "REDIS_URL", "INTERNAL_TOKEN", "APP_ENC_KEY", "ENGINE_HTTP_ADDR",
		"ENGINE_DB_MAX_CONNS", "ENGINE_CONFIG_RELOAD_INTERVAL", "LOG_LEVEL", "ENGINE_DB_MIN_CONNS"} {
		if !ve.Has(v) {
			t.Errorf("missing problem for %s in:\n%v", v, err)
		}
	}
	if !strings.Contains(err.Error(), "REDIS_URL is required") {
		t.Errorf("message: %v", err)
	}
}

func TestMissingKey(t *testing.T) {
	m := base()
	delete(m, "APP_ENC_KEY")
	_, err := LoadFrom(env(m))
	var ve *ValidationError
	if !errors.As(err, &ve) || !ve.Has("APP_ENC_KEY") || len(ve.Problems) != 1 {
		t.Fatalf("%v", err)
	}
}

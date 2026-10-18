package store

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

// HTTP connection rows (migration 007): NULL SMPP columns load, credentials
// are decrypted into a map, settings parsed, dlr_token indexed; a bad
// credentials blob makes the connection unusable without failing the load.
func TestLoadHTTPConnections(t *testing.T) {
	pool, _ := testEnv(t)
	c := testCipher(t)
	ctx := context.Background()
	good, bad, smpp := uuid.NewString(), uuid.NewString(), uuid.NewString()
	tok := "dlr_" + randHex(32)
	enc, _ := c.EncryptString(`{"token":"tok-123","webhook_secret":"whs","n":5}`)
	badEnc, _ := c.EncryptString(`not json`)
	pwEnc, _ := c.EncryptString("pw")
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO upstream_connections (id, name, kind, adapter, http_credentials_enc, http_settings, dlr_token, max_tps)
		  VALUES ($1, $2, 'HTTP', 'messengernepal', $3, '{"sender":"ALERT","max_concurrency":4}', $4, 20)`, []any{good, "http-" + randHex(8), enc, tok}},
		{`INSERT INTO upstream_connections (id, name, kind, adapter, http_credentials_enc, max_tps)
		  VALUES ($1, $2, 'HTTP', 'twozero', $3, 5)`, []any{bad, "http-" + randHex(8), badEnc}},
		{`INSERT INTO upstream_connections (id, name, host, port, system_id, password_enc, max_tps)
		  VALUES ($1, $2, '127.0.0.1', $3, 'sys', $4, 5)`, []any{smpp, "smpp-" + randHex(8), 2000 + len(randDigits(3)), pwEnc}},
	} {
		if _, err := pool.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		pool.Exec(context.Background(), `DELETE FROM upstream_connections WHERE id = ANY($1::uuid[])`, []string{good, bad, smpp})
	})
	st := New(pool, nil, c, Options{})
	if err := st.Load(ctx); err != nil {
		t.Fatal(err)
	}
	snap := st.Current()
	g := snap.Connection(good)
	if g == nil || !g.IsHTTP() || g.Adapter != "messengernepal" || g.PasswordErr != nil || g.HTTPCredentials["token"] != "tok-123" ||
		g.HTTPCredentials["n"] != "5" || g.HTTPSettings["sender"] != "ALERT" || g.HTTPSettings["max_concurrency"] != float64(4) ||
		g.DLRToken != tok || g.Host != "" || g.MaxTPS != 20 {
		t.Fatalf("http connection %+v", g)
	}
	if snap.ConnectionByDLRToken(tok) != g || snap.ConnectionByDLRToken("") != nil || snap.ConnectionByDLRToken("x") != nil {
		t.Fatal("dlr token index")
	}
	b := snap.Connection(bad)
	if b == nil || b.PasswordErr == nil || b.HTTPSettings == nil || len(b.HTTPCredentials) != 0 {
		t.Fatalf("bad credentials %+v", b)
	}
	s := snap.Connection(smpp)
	if s == nil || s.IsHTTP() || s.Kind != KindSMPP || s.Password != "pw" || s.PasswordErr != nil {
		t.Fatalf("smpp %+v", s)
	}
	// Kind participates in rebind decisions; HTTP fields in change detection.
	g2 := *g
	g2.HTTPCredentials = map[string]string{"token": "other"}
	if !g.SessionConfigEqual(&g2) || g.ConfigEqual(&g2) {
		t.Fatal("credential change must be an update without rebind")
	}
	s2 := *s
	s2.Kind = KindHTTP
	if s.SessionConfigEqual(&s2) {
		t.Fatal("kind change must rebind")
	}
}

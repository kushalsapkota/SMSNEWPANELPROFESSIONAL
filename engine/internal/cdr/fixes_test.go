package cdr

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
)

// NUL characters and invalid UTF-8 (e.g. a byte-truncated receipt field)
// are made storable instead of the whole row being dropped as a data error.
func TestTextIsSanitizedForPostgres(t *testing.T) {
	pool := testPool(t)
	w, ctx := newWriter(t, pool)
	org := uuid.NewString()
	cleanupOrg(t, pool, org)
	r := rec(org, uuid.NewString(), uuid.NewString(), time.Now().UTC().Truncate(time.Millisecond))
	r.OrigText, r.SentText, r.ClientMsgRef = "hello\x00nul", "bad \xff\xfe utf8", "ref\x00"
	if err := w.Insert(ctx, r); err != nil {
		t.Fatal(err)
	}
	if err := w.Update(ctx, Update{ID: r.ID, CreatedAt: r.CreatedAt, Status: StatusDelivered, DLRStat: str("DELIV\xe2\x82"),
		DLRErr: str("0\x000"), SMSCMsgIDs: []string{"a\x00b"}}); err != nil {
		t.Fatal(err)
	}
	if err := w.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	var orig, sent, ref, stat, status string
	err := pool.QueryRow(context.Background(), `SELECT orig_text, sent_text, client_msg_ref, dlr_stat, status::text FROM message_logs WHERE id = $1`, r.ID).
		Scan(&orig, &sent, &ref, &stat, &status)
	if err != nil {
		t.Fatalf("row dropped: %v", err)
	}
	if orig != "hellonul" || sent != "bad � utf8" || ref != "ref" || stat != "DELIV�" || status != StatusDelivered {
		t.Fatalf("stored %q %q %q %q %s", orig, sent, ref, stat, status)
	}
}

func TestTruncateKeepsCharacters(t *testing.T) {
	for in, want := range map[string]string{"DELIVRDX": "DELIVRD", "DELIV€€€": "DELIV€€", "short": "short", "ééééééééé": "ééééééé"} {
		if got := truncate(in, 7); got != want {
			t.Errorf("truncate(%q) = %q, want %q", in, got, want)
		}
	}
}

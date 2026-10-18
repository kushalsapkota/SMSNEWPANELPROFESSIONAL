package internalapi

import (
	"testing"

	"smsgw/engine/internal/pipeline"
)

// The api may choose the message id (`message_id`, UUIDv7) so that retries of a
// submit with an unknown outcome are idempotent; it is passed to the pipeline.
func TestSubmitMessageID(t *testing.T) {
	a, p, _, _ := newAPI()
	id := pipeline.NewMessageID()
	st, b := do(t, a, "POST", "/internal/v1/submit", `{"org_id":"`+client+`","channel":"HTTP","source":"S","destination":"447","text":"hi","message_id":"`+id+`"}`, token)
	if st != 200 || p.reqs[0].MessageID != id {
		t.Fatalf("%d %v %+v", st, b, p.reqs)
	}
	// batch items carry it too
	st, b = do(t, a, "POST", "/internal/v1/submit/batch", `{"items":[{"org_id":"`+client+`","channel":"HTTP","source":"S","destination":"448","text":"hi","message_id":"`+id+`"}]}`, token)
	if st != 200 || p.reqs[1].MessageID != id {
		t.Fatalf("batch %d %v", st, b)
	}
	// absent: the pipeline generates one
	do(t, a, "POST", "/internal/v1/submit", `{"org_id":"`+client+`","channel":"HTTP","source":"S","destination":"449","text":"hi"}`, token)
	if p.reqs[2].MessageID != "" {
		t.Fatalf("unexpected id %q", p.reqs[2].MessageID)
	}
	for _, bad := range []string{`"nope"`, `"3f1c2a4e-1d2b-4c3d-8e9f-0a1b2c3d4e5f"`} { // not a uuid / not v7
		st, b := do(t, a, "POST", "/internal/v1/submit", `{"org_id":"`+client+`","channel":"HTTP","source":"S","destination":"447","text":"hi","message_id":`+bad+`}`, token)
		if st != 400 || b["error_code"] != "INVALID_REQUEST" {
			t.Fatalf("%s: %d %v", bad, st, b)
		}
	}
}

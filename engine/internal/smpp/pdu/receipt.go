package pdu

import (
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"
	"unicode/utf8"
)

// Receipt is an SMSC delivery receipt as carried in the short_message of a
// deliver_sm with esm_class bit 0x04 (SMPP v3.4 Appendix B):
//
//	id:IIIIIIIIII sub:SSS dlvrd:DDD submit date:YYMMDDhhmm done date:YYMMDDhhmm stat:DDDDDDD err:E text:...
type Receipt struct {
	ID         string    // SMSC message id as written by the SMSC (see NormalizeMessageID)
	Sub        int       // number of messages originally submitted
	Dlvrd      int       // number delivered
	SubmitDate time.Time // zero if missing / unparseable (interpreted as UTC)
	DoneDate   time.Time
	Stat       string // normalized: DELIVRD, UNDELIV, EXPIRED, REJECTD, DELETED, UNKNOWN, ACCEPTD, ENROUTE (or the raw upper-cased word)
	Err        string // network specific error code, e.g. "000"
	Text       string // first characters of the original message

	// Raw values as found in the text (useful for logging odd SMSCs).
	SubmitDateRaw string
	DoneDateRaw   string
}

// ReceiptDateLayout is the receipt date format (YYMMDDhhmm).
const ReceiptDateLayout = "0601021504"

// MaxReceiptTextLen is how many characters of the original text Format keeps.
const MaxReceiptTextLen = 20

// Format renders the receipt in the canonical v3.4 Appendix B layout. Text is
// truncated to MaxReceiptTextLen runes; zero dates render as 0000000000.
func (r Receipt) Format() string {
	text := r.Text
	if utf8.RuneCountInString(text) > MaxReceiptTextLen {
		text = string([]rune(text)[:MaxReceiptTextLen])
	}
	errCode := r.Err
	if errCode == "" {
		errCode = "000"
	}
	stat := r.Stat
	if stat == "" {
		stat = "UNKNOWN"
	}
	return fmt.Sprintf("id:%s sub:%03d dlvrd:%03d submit date:%s done date:%s stat:%s err:%s text:%s",
		r.ID, r.Sub, r.Dlvrd, fmtReceiptDate(r.SubmitDate), fmtReceiptDate(r.DoneDate), stat, errCode, text)
}

func fmtReceiptDate(t time.Time) string {
	if t.IsZero() {
		return "0000000000"
	}
	return t.Format(ReceiptDateLayout)
}

// ErrNotReceipt is returned by ParseReceipt when the text has neither an id
// nor a stat field.
var ErrNotReceipt = errors.New("smpp: text is not a delivery receipt")

type receiptKey struct {
	name    string
	aliases []string // longest first where prefixes overlap
}

var receiptKeys = []receiptKey{
	{"submit date", []string{"submit date", "submit_date", "submit-date", "submitdate"}},
	{"done date", []string{"done date", "done_date", "done-date", "donedate"}},
	{"dlvrd", []string{"dlvrd", "dlvd", "delivered"}},
	{"stat", []string{"status", "stat"}},
	{"text", []string{"text", "txt"}},
	{"err", []string{"error", "err"}},
	{"sub", []string{"sub"}},
	{"id", []string{"msgid", "id"}},
}

type keyHit struct {
	key        string
	start, val int // start of key, start of value
}

// matchKeyAt checks for "<alias>[ ]*:" at lower[i:].
func matchKeyAt(lower string, i int) (string, int, bool) {
	for _, k := range receiptKeys {
		for _, a := range k.aliases {
			if !strings.HasPrefix(lower[i:], a) {
				continue
			}
			j := i + len(a)
			for j < len(lower) && lower[j] == ' ' {
				j++
			}
			if j < len(lower) && lower[j] == ':' {
				return k.name, j + 1, true
			}
		}
	}
	return "", 0, false
}

// ParseReceipt parses delivery receipt text. It is tolerant of real-world
// variants: keys in any case, "submit_date"/"submitdate" spellings, missing
// fields, extra spaces, fields in non-canonical order and a text field that
// itself contains colons (everything after "text:" is the text). Dates may be
// YYMMDDhhmm, YYMMDDhhmmss, YYYYMMDDhhmm or YYYYMMDDhhmmss.
func ParseReceipt(s string) (Receipt, error) {
	s = strings.TrimRight(s, "\x00")
	lower := asciiLower(s) // same byte length as s, so offsets map 1:1
	var hits []keyHit
	for i := 0; i < len(lower); i++ {
		if i > 0 {
			switch lower[i-1] {
			case ' ', '\t', ',', ';', '\n', '\r':
			default:
				continue
			}
		}
		name, val, ok := matchKeyAt(lower, i)
		if !ok {
			continue
		}
		hits = append(hits, keyHit{key: name, start: i, val: val})
		if name == "text" {
			break // the rest is free text
		}
		i = val - 1
	}
	var r Receipt
	found := map[string]bool{}
	for n, h := range hits {
		end := len(s)
		if n+1 < len(hits) {
			end = hits[n+1].start
		}
		v := s[h.val:end]
		if h.key != "text" {
			v = strings.TrimSpace(v)
			v = strings.Trim(v, ",;")
		} else {
			v = strings.TrimLeft(v, " ")
		}
		if found[h.key] {
			continue // first occurrence wins
		}
		found[h.key] = true
		switch h.key {
		case "id":
			r.ID = v
		case "sub":
			r.Sub = atoiLenient(v)
		case "dlvrd":
			r.Dlvrd = atoiLenient(v)
		case "submit date":
			r.SubmitDateRaw = v
			r.SubmitDate = parseReceiptDate(v)
		case "done date":
			r.DoneDateRaw = v
			r.DoneDate = parseReceiptDate(v)
		case "stat":
			r.Stat = NormalizeStat(v)
		case "err":
			r.Err = v
		case "text":
			r.Text = v
		}
	}
	if !found["id"] && !found["stat"] {
		return Receipt{}, ErrNotReceipt
	}
	return r, nil
}

func asciiLower(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + 'a' - 'A'
		}
	}
	return string(b)
}

func atoiLenient(s string) int {
	n := 0
	for i := 0; i < len(s) && s[i] >= '0' && s[i] <= '9'; i++ {
		n = n*10 + int(s[i]-'0')
		if n > 1_000_000 {
			break
		}
	}
	return n
}

func parseReceiptDate(s string) time.Time {
	var layout string
	switch len(s) {
	case 10:
		layout = "0601021504"
	case 12:
		layout = "060102150405"
	case 14:
		layout = "20060102150405"
	case 16: // some SMSCs append tenths + tz like the absolute time format
		layout = "060102150405"
		s = s[:12]
	default:
		return time.Time{}
	}
	t, err := time.ParseInLocation(layout, s, time.UTC)
	if err != nil {
		return time.Time{}
	}
	return t
}

// NormalizeStat upper-cases a receipt stat word and maps common long or
// misspelled forms to the 7-character v3.4 words.
func NormalizeStat(s string) string {
	u := strings.ToUpper(strings.TrimSpace(s))
	switch u {
	case "DELIVRD", "DELIVERED", "DELIVR", "DELIVRED":
		return "DELIVRD"
	case "UNDELIV", "UNDELIVERABLE", "UNDELIVERED", "UNDELIVRD":
		return "UNDELIV"
	case "REJECTD", "REJECTED", "REJECT":
		return "REJECTD"
	case "EXPIRED", "EXPIRD":
		return "EXPIRED"
	case "DELETED", "DELETD":
		return "DELETED"
	case "ACCEPTD", "ACCEPTED":
		return "ACCEPTD"
	case "ENROUTE", "EN_ROUTE":
		return "ENROUTE"
	case "UNKNOWN", "UNKNOWNN":
		return "UNKNOWN"
	}
	return u
}

// IsFinalStat reports whether a normalized stat is a final state.
func IsFinalStat(stat string) bool {
	switch stat {
	case "DELIVRD", "UNDELIV", "REJECTD", "EXPIRED", "DELETED", "UNKNOWN":
		return true
	}
	return false
}

// ReceiptFromDeliverSM extracts a delivery receipt from a deliver_sm. ok is
// false if the PDU is not a receipt (esm_class) or carries no usable id.
// TLVs take precedence over the text: receipted_message_id overrides the id
// and message_state fills Stat when the text has none.
func ReceiptFromDeliverSM(d *DeliverSM) (r Receipt, ok bool) {
	if !IsDeliveryReceipt(d.ESMClass) {
		return Receipt{}, false
	}
	r, err := ParseReceipt(string(d.Payload()))
	if err != nil {
		r = Receipt{}
	}
	if id, has := d.TLVs.ReceiptedMessageID(); has && strings.TrimSpace(id) != "" {
		r.ID = strings.TrimSpace(id)
	}
	if st, has := d.TLVs.MessageState(); has {
		if s := st.Stat(); s != "" && (r.Stat == "" || r.Stat == "UNKNOWN") {
			r.Stat = s
		}
	}
	if r.ID == "" {
		return r, false
	}
	return r, true
}

// NormalizeMessageID canonicalizes an SMSC message id for map keys: trims
// whitespace and NULs, lower-cases, and strips leading zeros (keeping a
// single "0"). Store ids from submit_sm_resp in this form and look receipts
// up with MessageIDVariants.
func NormalizeMessageID(id string) string {
	id = strings.ToLower(strings.Trim(id, " \t\r\n\x00"))
	t := strings.TrimLeft(id, "0")
	if t == "" && id != "" {
		return "0"
	}
	return t
}

// MessageIDVariants returns the normalized forms under which a receipt id
// may have been stored: the id itself, and — because many SMSCs return a hex
// id in submit_sm_resp but a decimal one in the receipt (or vice versa) — its
// decimal->hex and hex->decimal conversions. The first element is always
// NormalizeMessageID(id); duplicates are removed.
func MessageIDVariants(id string) []string {
	n := NormalizeMessageID(id)
	out := []string{n}
	add := func(v string) {
		for _, x := range out {
			if x == v {
				return
			}
		}
		out = append(out, v)
	}
	if n == "" || len(n) > 64 {
		return out
	}
	isDec, isHex := true, true
	for i := 0; i < len(n); i++ {
		c := n[i]
		if c < '0' || c > '9' {
			isDec = false
		}
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			isHex = false
		}
	}
	if isDec {
		if v, ok := new(big.Int).SetString(n, 10); ok {
			add(v.Text(16))
		}
	}
	if isHex {
		if v, ok := new(big.Int).SetString(n, 16); ok {
			add(v.Text(10))
		}
	}
	return out
}

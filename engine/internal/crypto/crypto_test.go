package crypto

import (
	"bytes"
	"encoding/base64"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

var testKey = bytes.Repeat([]byte{0x42}, 32)

func TestEncryptDecryptRoundTrip(t *testing.T) {
	c, err := NewCipher(testKey)
	if err != nil {
		t.Fatal(err)
	}
	for _, pt := range []string{"", "a", "secret12", strings.Repeat("x", 4096), "ünïcødé ✓"} {
		enc, err := c.EncryptString(pt)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(enc, "v1:") {
			t.Fatalf("missing prefix: %q", enc)
		}
		raw, err := base64.StdEncoding.DecodeString(enc[3:])
		if err != nil {
			t.Fatalf("not std base64: %v", err)
		}
		if len(raw) != 12+len(pt)+16 {
			t.Fatalf("layout: got %d bytes for %d plaintext", len(raw), len(pt))
		}
		got, err := c.DecryptString(enc)
		if err != nil || got != pt {
			t.Fatalf("roundtrip %q -> %q, %v", pt, got, err)
		}
	}
}

func TestEncryptUniqueNonces(t *testing.T) {
	a, _ := Encrypt(testKey, []byte("same"))
	b, _ := Encrypt(testKey, []byte("same"))
	if a == b {
		t.Fatal("two encryptions produced identical output")
	}
}

func TestDecryptErrors(t *testing.T) {
	c, _ := NewCipher(testKey)
	enc, _ := c.EncryptString("hello")
	raw, _ := base64.StdEncoding.DecodeString(enc[3:])
	raw[len(raw)-1] ^= 1
	tampered := "v1:" + base64.StdEncoding.EncodeToString(raw)

	other, _ := NewCipher(bytes.Repeat([]byte{1}, 32))
	cases := map[string]struct {
		c   *Cipher
		in  string
		err error
	}{
		"no prefix":   {c, enc[3:], ErrBadFormat},
		"v2 prefix":   {c, "v2:" + enc[3:], ErrBadFormat},
		"bad base64":  {c, "v1:!!!", ErrBadFormat},
		"too short":   {c, "v1:" + base64.StdEncoding.EncodeToString(make([]byte, 27)), ErrBadFormat},
		"tampered":    {c, tampered, ErrDecrypt},
		"wrong key":   {other, enc, ErrDecrypt},
		"empty input": {c, "", ErrBadFormat},
	}
	for name, tc := range cases {
		if _, err := tc.c.Decrypt(tc.in); !errors.Is(err, tc.err) {
			t.Errorf("%s: got %v want %v", name, err, tc.err)
		}
	}
	if _, err := NewCipher(make([]byte, 16)); !errors.Is(err, ErrBadKey) {
		t.Errorf("short key: %v", err)
	}
}

// Fixed vector: decrypting a value with a known nonce must yield the plaintext,
// proving the nonce||ct||tag layout (not ct||nonce etc).
func TestDecryptKnownLayout(t *testing.T) {
	c, _ := NewCipher(testKey)
	nonce := bytes.Repeat([]byte{7}, 12)
	sealed := c.aead.Seal(append([]byte{}, nonce...), nonce, []byte("pw123"), nil)
	got, err := c.DecryptString("v1:" + base64.StdEncoding.EncodeToString(sealed))
	if err != nil || got != "pw123" {
		t.Fatalf("got %q %v", got, err)
	}
}

func TestParseKey(t *testing.T) {
	b64 := base64.StdEncoding.EncodeToString(testKey)
	k, err := ParseKey(" " + b64 + "\n")
	if err != nil || !bytes.Equal(k, testKey) {
		t.Fatalf("std: %v", err)
	}
	k, err = ParseKey(strings.TrimRight(b64, "="))
	if err != nil || !bytes.Equal(k, testKey) {
		t.Fatalf("raw: %v", err)
	}
	if _, err := ParseKey(base64.StdEncoding.EncodeToString(make([]byte, 31))); err == nil {
		t.Fatal("31-byte key accepted")
	}
	if _, err := ParseKey("not base64 !!"); err == nil {
		t.Fatal("garbage accepted")
	}
}

// Interop with Node's AES-256-GCM (the api's implementation uses node:crypto).
// Skipped when node is not installed.
func TestNodeInterop(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not installed")
	}
	keyB64 := base64.StdEncoding.EncodeToString(testKey)
	script := `
const c = require('crypto');
const key = Buffer.from(process.argv[2], 'base64');
const mode = process.argv[3];
if (mode === 'enc') {
  const iv = c.randomBytes(12);
  const ci = c.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([ci.update(process.argv[4], 'utf8'), ci.final()]);
  process.stdout.write('v1:' + Buffer.concat([iv, ct, ci.getAuthTag()]).toString('base64'));
} else {
  const raw = Buffer.from(process.argv[4].slice(3), 'base64');
  const d = c.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(raw.length - 16));
  process.stdout.write(Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString('utf8'));
}`
	dir := t.TempDir()
	path := filepath.Join(dir, "gcm.js")
	if err := os.WriteFile(path, []byte(script), 0o600); err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command(node, path, keyB64, "enc", "från node ✓").Output()
	if err != nil {
		t.Fatalf("node enc: %v", err)
	}
	got, err := Decrypt(testKey, string(out))
	if err != nil || string(got) != "från node ✓" {
		t.Fatalf("go decrypt of node value: %q %v", got, err)
	}
	enc, _ := Encrypt(testKey, []byte("from go ✓"))
	out, err = exec.Command(node, path, keyB64, "dec", enc).Output()
	if err != nil || string(out) != "from go ✓" {
		t.Fatalf("node decrypt of go value: %q %v", out, err)
	}
}

func TestHashVerify(t *testing.T) {
	h, err := HashPassword("s3cret!")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(h, "$argon2id$v=19$m=19456,t=2,p=1$") {
		t.Fatalf("format: %s", h)
	}
	parts := strings.Split(h, "$")
	if strings.Contains(parts[4], "=") || strings.Contains(parts[5], "=") {
		t.Fatalf("padding present: %s", h)
	}
	p, err := ParsePHC(h)
	if err != nil || len(p.Salt) != 16 || len(p.Hash) != 32 {
		t.Fatalf("parse: %+v %v", p, err)
	}
	if ok, err := VerifyPassword("s3cret!", h); !ok || err != nil {
		t.Fatalf("verify ok: %v %v", ok, err)
	}
	if ok, _ := VerifyPassword("s3cret?", h); ok {
		t.Fatal("wrong password verified")
	}
	if NeedsRehash(h) {
		t.Fatal("fresh hash needs rehash")
	}
	h2, _ := HashPassword("s3cret!")
	if h == h2 {
		t.Fatal("salt not random")
	}
}

// Known-answer test: deterministic salt -> must be reproducible and must
// verify, and a different-parameter hash (t=3) must still verify (we honour
// the parameters embedded in the PHC string, like node-rs does).
func TestVerifyHonoursEmbeddedParams(t *testing.T) {
	salt := []byte("0123456789abcdef")
	h := hashWithSalt("pw", salt)
	if h != hashWithSalt("pw", salt) {
		t.Fatal("not deterministic")
	}
	if ok, _ := VerifyPassword("pw", h); !ok {
		t.Fatal("kat verify")
	}
	alt := "$argon2id$v=19$m=8192,t=3,p=1$" + base64.RawStdEncoding.EncodeToString(salt) + "$"
	key := argon2IDForTest("pw", salt, 3, 8192, 1, 32)
	alt += base64.RawStdEncoding.EncodeToString(key)
	if ok, err := VerifyPassword("pw", alt); !ok || err != nil {
		t.Fatalf("alt params: %v %v", ok, err)
	}
	if !NeedsRehash(alt) {
		t.Fatal("alt params should need rehash")
	}
}

func TestParsePHCRejects(t *testing.T) {
	good := hashWithSalt("pw", []byte("0123456789abcdef"))
	bad := []string{
		"",
		"plain",
		strings.Replace(good, "argon2id", "argon2i", 1),
		strings.Replace(good, "v=19", "v=16", 1),
		strings.Replace(good, "m=19456", "m=abc", 1),
		strings.Replace(good, "p=1", "p=0", 1),
		strings.Replace(good, "t=2", "t=0", 1),
		strings.Replace(good, "m=19456", "m=99999999", 1),
		strings.Replace(good, ",p=1", "", 1),
		good + "$extra",
	}
	for _, b := range bad {
		if _, err := ParsePHC(b); err == nil {
			t.Errorf("accepted %q", b)
		}
		if ok, _ := VerifyPassword("pw", b); ok {
			t.Errorf("verified %q", b)
		}
	}
	// Missing version segment is legal PHC but only v=19 is supported; the
	// implicit version is 0x10, so it must be rejected rather than mis-verified.
	noVer := strings.Replace(good, "$v=19", "", 1)
	if _, err := ParsePHC(noVer); err == nil {
		t.Error("versionless (v=16) accepted")
	}
	// Padded base64 (some encoders emit it) is tolerated.
	parts := strings.Split(good, "$")
	padded := strings.Join([]string{"", parts[1], parts[2], parts[3], parts[4] + "==", parts[5] + "="}, "$")
	if ok, err := VerifyPassword("pw", padded); !ok || err != nil {
		t.Errorf("padded: %v %v", ok, err)
	}
}

func TestBindCache(t *testing.T) {
	h, _ := HashPassword("pw1")
	c := NewBindCache(50*time.Millisecond, 0)
	now := time.Now()
	c.now = func() time.Time { return now }
	if ok, err := c.Verify("sys", "pw1", h); !ok || err != nil {
		t.Fatalf("first verify: %v %v", ok, err)
	}
	if c.Len() != 1 {
		t.Fatalf("len %d", c.Len())
	}
	if ok, _ := c.Verify("sys", "bad", h); ok {
		t.Fatal("bad password accepted")
	}
	if c.Len() != 1 {
		t.Fatal("failure was cached")
	}
	// Cache hit must not depend on hash re-evaluation: swap in a hash the
	// password doesn't match; key includes the hash so it's a miss.
	h2, _ := HashPassword("other")
	if ok, _ := c.Verify("sys", "pw1", h2); ok {
		t.Fatal("rotated hash accepted old password")
	}
	if ok, _ := c.Verify("sys2", "pw1", h); !ok {
		t.Fatal("other system id, same hash: should verify via argon2")
	}
	// Expiry
	now = now.Add(time.Second)
	if ok, _ := c.Verify("sys", "pw1", h); !ok {
		t.Fatal("expired entry should re-verify successfully")
	}
	c.Forget()
	if c.Len() != 0 {
		t.Fatal("forget")
	}
	if _, err := c.Verify("s", "p", "junk"); !errors.Is(err, ErrBadHash) {
		t.Fatalf("junk hash err %v", err)
	}
}

func TestBindCacheMaxSize(t *testing.T) {
	h, _ := HashPassword("pw")
	c := NewBindCache(time.Hour, 3)
	for _, s := range []string{"a", "b", "c", "d", "e"} {
		if ok, _ := c.Verify(s, "pw", h); !ok {
			t.Fatal("verify")
		}
		if c.Len() > 3 {
			t.Fatalf("size %d > max", c.Len())
		}
	}
}

func TestBindCacheConcurrent(t *testing.T) {
	h, _ := HashPassword("pw")
	c := NewBindCache(time.Minute, 0)
	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			for j := 0; j < 5; j++ {
				pw := "pw"
				if (i+j)%3 == 0 {
					pw = "nope"
				}
				ok, _ := c.Verify("sys", pw, h)
				if ok != (pw == "pw") {
					t.Errorf("mismatch for %s", pw)
				}
			}
		}(i)
	}
	wg.Wait()
}

// Interop with @node-rs/argon2 (the api's hasher), using the api's
// node_modules when present.
func TestNodeRsArgon2Interop(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not installed")
	}
	mods, _ := filepath.Abs("../../../api/node_modules")
	if _, err := os.Stat(filepath.Join(mods, "@node-rs", "argon2")); err != nil {
		t.Skip("@node-rs/argon2 not installed in api/node_modules")
	}
	script := `
const a = require('@node-rs/argon2');
(async () => {
  if (process.argv[2] === 'hash') process.stdout.write(await a.hash(process.argv[3]));
  else process.stdout.write(String(await a.verify(process.argv[4], process.argv[3])));
})().catch(e => { console.error(e); process.exit(1); });`
	path := filepath.Join(t.TempDir(), "a2.js")
	if err := os.WriteFile(path, []byte(script), 0o600); err != nil {
		t.Fatal(err)
	}
	run := func(args ...string) string {
		cmd := exec.Command(node, append([]string{path}, args...)...)
		cmd.Env = append(os.Environ(), "NODE_PATH="+mods)
		out, err := cmd.Output()
		if err != nil {
			t.Fatalf("node %v: %v", args, err)
		}
		return string(out)
	}
	nh := run("hash", "nodepw")
	if !strings.HasPrefix(nh, "$argon2id$v=19$m=19456,t=2,p=1$") {
		t.Fatalf("node-rs default format changed: %s", nh)
	}
	if ok, err := VerifyPassword("nodepw", nh); !ok || err != nil {
		t.Fatalf("go verify of node hash: %v %v", ok, err)
	}
	gh, _ := HashPassword("gopw")
	if got := run("verify", "gopw", gh); got != "true" {
		t.Fatalf("node verify of go hash: %s", got)
	}
	if got := run("verify", "wrong", gh); got != "false" {
		t.Fatalf("node verify wrong pw: %s", got)
	}
}

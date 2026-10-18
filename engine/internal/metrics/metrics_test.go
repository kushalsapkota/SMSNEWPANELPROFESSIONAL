package metrics

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func TestExposition(t *testing.T) {
	r := NewRegistry()
	c := r.Counter("req_total", "Requests.", "code", "path")
	c.With("200", `/a"b`).Add(3)
	c.With("500", "/x").Inc()
	g := r.Gauge("temp", "Temperature\nnow.")
	g.Set(-1.5)
	r.GaugeFunc("conn_up", "Up.", []string{"id"}, func() []Sample {
		return []Sample{{[]string{"b"}, 0}, {[]string{"a"}, 1}}
	})
	h := r.Histogram("lat_seconds", "Latency.", []float64{0.1, 1})
	h.Observe(0.05)
	h.Observe(0.5)
	h.Observe(3)
	out := r.Text()
	for _, want := range []string{
		"# HELP req_total Requests.\n# TYPE req_total counter\n",
		`req_total{code="200",path="/a\"b"} 3` + "\n",
		`req_total{code="500",path="/x"} 1` + "\n",
		"# HELP temp Temperature\\nnow.\n",
		"temp -1.5\n",
		"conn_up{id=\"a\"} 1\nconn_up{id=\"b\"} 0\n",
		`lat_seconds_bucket{le="0.1"} 1`, `lat_seconds_bucket{le="1"} 2`, `lat_seconds_bucket{le="+Inf"} 3`,
		"lat_seconds_sum 3.55\n", "lat_seconds_count 3\n",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in\n%s", want, out)
		}
	}
	// families sorted by name
	if strings.Index(out, "conn_up") > strings.Index(out, "lat_seconds") || strings.Index(out, "req_total") > strings.Index(out, "temp") {
		t.Errorf("not sorted:\n%s", out)
	}
	srv := httptest.NewServer(r.Handler())
	defer srv.Close()
	resp, err := http.Get(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/plain; version=0.0.4") || string(b) != r.Text() {
		t.Fatalf("handler: %s %q", resp.Header.Get("Content-Type"), b)
	}
}

func TestConcurrentCounter(t *testing.T) {
	r := NewRegistry()
	c := r.Counter("n_total", "N.", "k")
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 1000; j++ {
				c.With("x").Inc()
			}
		}()
	}
	wg.Wait()
	if v := c.With("x").Value(); v != 50000 {
		t.Fatalf("got %v", v)
	}
	c.With("x").Add(-5) // ignored
	if v := c.With("x").Value(); v != 50000 {
		t.Fatalf("negative add changed counter: %v", v)
	}
}

func TestRateMeter(t *testing.T) {
	now := int64(100)
	m := NewRateMeter(func() int64 { return now })
	m.Add(5)
	if m.Rate() != 0 {
		t.Fatal("current second must not count")
	}
	now = 101
	m.Add(2)
	if m.Rate() != 5 {
		t.Fatalf("rate %v", m.Rate())
	}
	now = 105
	if m.Rate() != 0 {
		t.Fatalf("stale rate %v", m.Rate())
	}
}

func TestPanics(t *testing.T) {
	r := NewRegistry()
	r.Counter("a", "")
	for _, f := range []func(){
		func() { r.Counter("a", "") },
		func() { r.Counter("1bad", "") },
		func() { r.Counter("b", "", "x").With() },
	} {
		func() {
			defer func() {
				if recover() == nil {
					t.Error("expected panic")
				}
			}()
			f()
		}()
	}
}

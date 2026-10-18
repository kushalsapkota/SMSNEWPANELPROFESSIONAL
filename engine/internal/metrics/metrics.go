// Package metrics is a small, dependency-free Prometheus registry: counters,
// gauges (set directly or computed by a callback at scrape time) and
// histograms, each optionally labelled, rendered in the Prometheus text
// exposition format (version 0.0.4).
//
//	reg := metrics.NewRegistry()
//	sent := reg.Counter("sms_submit_total", "Submissions.", "channel", "result")
//	sent.With("HTTP", "accepted").Inc()
//	http.Handle("/metrics", reg.Handler())
//
// All types are safe for concurrent use. Label values are passed
// positionally in the order the label names were declared.
package metrics

import (
	"bufio"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
)

// Registry holds metric families and renders them.
type Registry struct {
	mu       sync.Mutex
	families map[string]family
	order    []string
}

type family interface {
	write(w *bufio.Writer)
}

// NewRegistry creates an empty registry.
func NewRegistry() *Registry {
	return &Registry{families: map[string]family{}}
}

func (r *Registry) register(name string, f family) {
	if !validName(name) {
		panic(fmt.Sprintf("metrics: invalid metric name %q", name))
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, dup := r.families[name]; dup {
		panic(fmt.Sprintf("metrics: duplicate metric %q", name))
	}
	r.families[name] = f
	r.order = append(r.order, name)
}

func validName(s string) bool {
	if s == "" {
		return false
	}
	for i, c := range s {
		switch {
		case c == '_' || c == ':' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'):
		case c >= '0' && c <= '9' && i > 0:
		default:
			return false
		}
	}
	return true
}

// WriteTo renders every family (sorted by name) in text format.
func (r *Registry) WriteTo(w *bufio.Writer) {
	r.mu.Lock()
	names := append([]string(nil), r.order...)
	fams := make([]family, 0, len(names))
	sort.Strings(names)
	for _, n := range names {
		fams = append(fams, r.families[n])
	}
	r.mu.Unlock()
	for _, f := range fams {
		f.write(w)
	}
}

// Text returns the exposition as a string (tests, debugging).
func (r *Registry) Text() string {
	var b strings.Builder
	w := bufio.NewWriter(&b)
	r.WriteTo(w)
	_ = w.Flush()
	return b.String()
}

// Handler serves the exposition (GET /metrics).
func (r *Registry) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Method != http.MethodGet && req.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		bw := bufio.NewWriterSize(w, 32*1024)
		r.WriteTo(bw)
		_ = bw.Flush()
	})
}

// --- label handling ----------------------------------------------------------

type labeled[T any] struct {
	name, help, typ string
	labels          []string
	newChild        func() *T
	writeChild      func(w *bufio.Writer, name, labels string, c *T)

	mu       sync.RWMutex
	children map[string]*T
	keys     map[string][]string
}

func (l *labeled[T]) with(values ...string) *T {
	if len(values) != len(l.labels) {
		panic(fmt.Sprintf("metrics: %s expects %d label values, got %d", l.name, len(l.labels), len(values)))
	}
	key := strings.Join(values, "\xff")
	l.mu.RLock()
	c, ok := l.children[key]
	l.mu.RUnlock()
	if ok {
		return c
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if c, ok = l.children[key]; ok {
		return c
	}
	c = l.newChild()
	l.children[key] = c
	l.keys[key] = append([]string(nil), values...)
	return c
}

func (l *labeled[T]) write(w *bufio.Writer) {
	writeHeader(w, l.name, l.help, l.typ)
	l.mu.RLock()
	keys := make([]string, 0, len(l.children))
	for k := range l.children {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	type kv struct {
		labels string
		c      *T
	}
	items := make([]kv, 0, len(keys))
	for _, k := range keys {
		items = append(items, kv{formatLabels(l.labels, l.keys[k]), l.children[k]})
	}
	l.mu.RUnlock()
	for _, it := range items {
		l.writeChild(w, l.name, it.labels, it.c)
	}
}

func writeHeader(w *bufio.Writer, name, help, typ string) {
	w.WriteString("# HELP ")
	w.WriteString(name)
	w.WriteByte(' ')
	w.WriteString(escapeHelp(help))
	w.WriteString("\n# TYPE ")
	w.WriteString(name)
	w.WriteByte(' ')
	w.WriteString(typ)
	w.WriteByte('\n')
}

func escapeHelp(s string) string {
	return strings.NewReplacer(`\`, `\\`, "\n", `\n`).Replace(s)
}

func escapeLabel(s string) string {
	return strings.NewReplacer(`\`, `\\`, "\n", `\n`, `"`, `\"`).Replace(s)
}

func formatLabels(names, values []string) string {
	if len(names) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteByte('{')
	for i, n := range names {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(n)
		b.WriteString(`="`)
		b.WriteString(escapeLabel(values[i]))
		b.WriteByte('"')
	}
	b.WriteByte('}')
	return b.String()
}

// mergeLabels inserts extra (already formatted k="v") into a label set.
func mergeLabels(labels, extra string) string {
	if labels == "" {
		return "{" + extra + "}"
	}
	return labels[:len(labels)-1] + "," + extra + "}"
}

func formatFloat(v float64) string {
	switch {
	case math.IsInf(v, 1):
		return "+Inf"
	case math.IsInf(v, -1):
		return "-Inf"
	case math.IsNaN(v):
		return "NaN"
	}
	return strconv.FormatFloat(v, 'g', -1, 64)
}

func writeSample(w *bufio.Writer, name, labels string, v float64) {
	w.WriteString(name)
	w.WriteString(labels)
	w.WriteByte(' ')
	w.WriteString(formatFloat(v))
	w.WriteByte('\n')
}

// --- counter -----------------------------------------------------------------

// CounterValue is one counter time series.
type CounterValue struct{ bits atomic.Uint64 }

// Inc adds 1.
func (c *CounterValue) Inc() { c.Add(1) }

// Add adds v (negative values are ignored: counters only go up).
func (c *CounterValue) Add(v float64) {
	if v <= 0 || math.IsNaN(v) {
		return
	}
	for {
		old := c.bits.Load()
		n := math.Float64bits(math.Float64frombits(old) + v)
		if c.bits.CompareAndSwap(old, n) {
			return
		}
	}
}

// Value returns the current value.
func (c *CounterValue) Value() float64 { return math.Float64frombits(c.bits.Load()) }

// Counter is a counter family.
type Counter struct{ l *labeled[CounterValue] }

// Counter registers a counter family with the given label names.
func (r *Registry) Counter(name, help string, labels ...string) *Counter {
	c := &Counter{l: &labeled[CounterValue]{
		name: name, help: help, typ: "counter", labels: labels,
		newChild: func() *CounterValue { return &CounterValue{} },
		writeChild: func(w *bufio.Writer, name, labels string, c *CounterValue) {
			writeSample(w, name, labels, c.Value())
		},
		children: map[string]*CounterValue{}, keys: map[string][]string{},
	}}
	r.register(name, c.l)
	if len(labels) == 0 {
		c.l.with() // always expose the unlabelled series
	}
	return c
}

// With returns the series for the label values.
func (c *Counter) With(values ...string) *CounterValue { return c.l.with(values...) }

// Inc increments the unlabelled series.
func (c *Counter) Inc() { c.l.with().Inc() }

// Add adds to the unlabelled series.
func (c *Counter) Add(v float64) { c.l.with().Add(v) }

// --- gauge -------------------------------------------------------------------

// GaugeValue is one gauge time series.
type GaugeValue struct{ bits atomic.Uint64 }

// Set sets the value.
func (g *GaugeValue) Set(v float64) { g.bits.Store(math.Float64bits(v)) }

// Add adds v (may be negative).
func (g *GaugeValue) Add(v float64) {
	for {
		old := g.bits.Load()
		n := math.Float64bits(math.Float64frombits(old) + v)
		if g.bits.CompareAndSwap(old, n) {
			return
		}
	}
}

// Inc adds 1; Dec subtracts 1.
func (g *GaugeValue) Inc() { g.Add(1) }
func (g *GaugeValue) Dec() { g.Add(-1) }

// Value returns the current value.
func (g *GaugeValue) Value() float64 { return math.Float64frombits(g.bits.Load()) }

// Gauge is a gauge family.
type Gauge struct{ l *labeled[GaugeValue] }

// Gauge registers a gauge family.
func (r *Registry) Gauge(name, help string, labels ...string) *Gauge {
	g := &Gauge{l: &labeled[GaugeValue]{
		name: name, help: help, typ: "gauge", labels: labels,
		newChild: func() *GaugeValue { return &GaugeValue{} },
		writeChild: func(w *bufio.Writer, name, labels string, g *GaugeValue) {
			writeSample(w, name, labels, g.Value())
		},
		children: map[string]*GaugeValue{}, keys: map[string][]string{},
	}}
	r.register(name, g.l)
	if len(labels) == 0 {
		g.l.with()
	}
	return g
}

// With returns the series for the label values.
func (g *Gauge) With(values ...string) *GaugeValue { return g.l.with(values...) }

// Set sets the unlabelled series.
func (g *Gauge) Set(v float64) { g.l.with().Set(v) }

// Sample is one labelled value produced by a GaugeFunc callback.
type Sample struct {
	LabelValues []string
	Value       float64
}

type gaugeFunc struct {
	name, help string
	labels     []string
	fn         func() []Sample
}

func (g *gaugeFunc) write(w *bufio.Writer) {
	samples := g.fn()
	writeHeader(w, g.name, g.help, "gauge")
	sort.SliceStable(samples, func(i, j int) bool {
		return strings.Join(samples[i].LabelValues, "\xff") < strings.Join(samples[j].LabelValues, "\xff")
	})
	for _, s := range samples {
		if len(s.LabelValues) != len(g.labels) {
			continue
		}
		writeSample(w, g.name, formatLabels(g.labels, s.LabelValues), s.Value)
	}
}

// GaugeFunc registers a gauge whose samples are computed at scrape time.
// fn must be fast and safe for concurrent use.
func (r *Registry) GaugeFunc(name, help string, labels []string, fn func() []Sample) {
	r.register(name, &gaugeFunc{name: name, help: help, labels: labels, fn: fn})
}

// --- histogram ---------------------------------------------------------------

// DefaultLatencyBuckets are seconds buckets suited to SMS submit latencies.
var DefaultLatencyBuckets = []float64{0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10}

// HistogramValue is one histogram time series.
type HistogramValue struct {
	upper  []float64
	counts []atomic.Uint64 // non-cumulative per bucket, last = +Inf
	count  atomic.Uint64
	sum    CounterValue
	sumNeg GaugeValue // negative observations (rare) tracked separately
}

// Observe records v.
func (h *HistogramValue) Observe(v float64) {
	i := sort.SearchFloat64s(h.upper, v)
	h.counts[i].Add(1)
	h.count.Add(1)
	if v >= 0 {
		h.sum.Add(v)
	} else {
		h.sumNeg.Add(v)
	}
}

// Count returns the number of observations.
func (h *HistogramValue) Count() uint64 { return h.count.Load() }

// Histogram is a histogram family.
type Histogram struct{ l *labeled[HistogramValue] }

// Histogram registers a histogram family with the given upper bounds
// (sorted ascending; +Inf is implicit). nil buckets = DefaultLatencyBuckets.
func (r *Registry) Histogram(name, help string, buckets []float64, labels ...string) *Histogram {
	if buckets == nil {
		buckets = DefaultLatencyBuckets
	}
	b := append([]float64(nil), buckets...)
	sort.Float64s(b)
	h := &Histogram{l: &labeled[HistogramValue]{
		name: name, help: help, typ: "histogram", labels: labels,
		newChild: func() *HistogramValue {
			return &HistogramValue{upper: b, counts: make([]atomic.Uint64, len(b)+1)}
		},
		writeChild: func(w *bufio.Writer, name, labels string, h *HistogramValue) {
			var cum uint64
			for i, ub := range h.upper {
				cum += h.counts[i].Load()
				writeSample(w, name+"_bucket", mergeLabels(labels, `le="`+formatFloat(ub)+`"`), float64(cum))
			}
			cum += h.counts[len(h.upper)].Load()
			writeSample(w, name+"_bucket", mergeLabels(labels, `le="+Inf"`), float64(cum))
			writeSample(w, name+"_sum", labels, h.sum.Value()+h.sumNeg.Value())
			writeSample(w, name+"_count", labels, float64(cum))
		},
		children: map[string]*HistogramValue{}, keys: map[string][]string{},
	}}
	r.register(name, h.l)
	if len(labels) == 0 {
		h.l.with()
	}
	return h
}

// With returns the series for the label values.
func (h *Histogram) With(values ...string) *HistogramValue { return h.l.with(values...) }

// Observe records into the unlabelled series.
func (h *Histogram) Observe(v float64) { h.l.with().Observe(v) }

// --- rate meter --------------------------------------------------------------

// RateMeter counts events per wall-clock second and reports the count of
// the last complete second (an instantaneous TPS reading).
type RateMeter struct {
	mu        sync.Mutex
	sec       int64
	cur, prev uint64
	now       func() int64
}

// NewRateMeter creates a meter using clock (nil = time.Now().Unix()).
func NewRateMeter(clock func() int64) *RateMeter {
	if clock == nil {
		clock = unixNow
	}
	return &RateMeter{now: clock}
}

func (r *RateMeter) roll(now int64) {
	switch {
	case now == r.sec:
	case now == r.sec+1:
		r.prev, r.cur, r.sec = r.cur, 0, now
	default:
		r.prev, r.cur, r.sec = 0, 0, now
	}
}

// Add records n events now.
func (r *RateMeter) Add(n uint64) {
	r.mu.Lock()
	r.roll(r.clock())
	r.cur += n
	r.mu.Unlock()
}

// Rate returns the event count of the last complete second.
func (r *RateMeter) Rate() float64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.roll(r.clock())
	return float64(r.prev)
}

func (r *RateMeter) clock() int64 {
	if r.now == nil {
		return unixNow()
	}
	return r.now()
}

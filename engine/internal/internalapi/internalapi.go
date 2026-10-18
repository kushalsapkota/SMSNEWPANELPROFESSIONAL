// Package internalapi serves the engine's internal HTTP API (CONTRACTS §5),
// called only by the api service. Every request must carry
// X-Internal-Token; every error is JSON {"error_code","message"} with the
// status from policy.HTTPStatus.
package internalapi

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"runtime/debug"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"smsgw/engine/internal/billing"
	"smsgw/engine/internal/dispatch"
	"smsgw/engine/internal/pipeline"
	"smsgw/engine/internal/policy"
	"smsgw/engine/internal/smpp/server"
	"smsgw/engine/internal/store"
)

// Submitter is the pipeline.
type Submitter interface {
	Submit(ctx context.Context, req pipeline.Request) (*pipeline.Result, error)
	Preview(ctx context.Context, req pipeline.PreviewRequest) (*pipeline.PreviewResult, error)
}

// Connections reports upstream status (dispatch.Manager).
type Connections interface {
	Status() []dispatch.ConnStatus
	QueueDepth() int64
	ConnectionsUp() (up, total int)
}

// SMPPServer is the client-facing SMPP server.
type SMPPServer interface {
	Sessions() []server.SessionInfo
	Kick(orgID string) int
}

// Balances is the subset of *billing.Biller used here.
type Balances interface {
	Credit(ctx context.Context, tag, orgID string, delta int64, idemKey string) (billing.CreditResult, error)
	Balance(ctx context.Context, tag, orgID string) (billing.BalanceInfo, error)
}

// Snapshotter is *store.Store.
type Snapshotter interface {
	Current() *store.Snapshot
}

// Rates reports engine throughput for GET /internal/v1/stats.
type Rates interface {
	TPSIn() float64
	TPSOut() float64
}

// Deps are the handler's collaborators.
type Deps struct {
	Token       string
	Pipeline    Submitter
	Connections Connections
	SMPP        SMPPServer
	Balances    Balances
	Store       Snapshotter
	DB          *pgxpool.Pool
	Redis       redis.UniversalClient
	Rates       Rates
	MaxBody     int64 // default 8 MiB
	BatchMax    int   // default 1000
	BatchPar    int   // concurrent items of a batch; default 16
	Logger      *slog.Logger
}

// API is the http.Handler.
type API struct {
	d   Deps
	mux *http.ServeMux
	log *slog.Logger
}

// New builds the handler.
func New(d Deps) *API {
	if d.MaxBody <= 0 {
		d.MaxBody = 8 << 20
	}
	if d.BatchMax <= 0 {
		d.BatchMax = 1000
	}
	if d.BatchPar <= 0 {
		d.BatchPar = 16
	}
	if d.Logger == nil {
		d.Logger = slog.Default()
	}
	a := &API{d: d, mux: http.NewServeMux(), log: d.Logger.With("component", "internalapi")}
	a.mux.HandleFunc("POST /internal/v1/submit", a.submit)
	a.mux.HandleFunc("POST /internal/v1/submit/batch", a.submitBatch)
	a.mux.HandleFunc("POST /internal/v1/template/preview", a.preview)
	a.mux.HandleFunc("GET /internal/v1/connections/status", a.connStatus)
	a.mux.HandleFunc("GET /internal/v1/smpp/sessions", a.sessions)
	a.mux.HandleFunc("POST /internal/v1/smpp/sessions/kick", a.kick)
	a.mux.HandleFunc("POST /internal/v1/balance/credit", a.credit)
	a.mux.HandleFunc("GET /internal/v1/balance/{org_id}", a.balance)
	a.mux.HandleFunc("GET /internal/v1/health", a.health)
	a.mux.HandleFunc("GET /internal/v1/stats", a.stats)
	a.mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, policy.New(policy.CodeNotFound, "no such endpoint"))
	})
	return a
}

// ServeHTTP authenticates, recovers panics and routes.
func (a *API) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	defer func() {
		if p := recover(); p != nil {
			a.log.Error("panic in handler", "path", r.URL.Path, "panic", p, "stack", string(debug.Stack()))
			writeError(w, policy.New(policy.CodeInternal, "internal error"))
		}
	}()
	tok := r.Header.Get("X-Internal-Token")
	if a.d.Token == "" || subtle.ConstantTimeCompare([]byte(tok), []byte(a.d.Token)) != 1 {
		writeError(w, policy.New(policy.CodeUnauthorized, "missing or invalid X-Internal-Token"))
		return
	}
	if r.Body != nil {
		r.Body = http.MaxBytesReader(w, r.Body, a.d.MaxBody)
	}
	a.mux.ServeHTTP(w, r)
}

// --- helpers -----------------------------------------------------------------

type errorBody struct {
	ErrorCode string `json:"error_code"`
	Message   string `json:"message"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func errBody(err error) (int, errorBody) {
	pe := policy.As(err)
	msg := pe.Message
	if pe.Code == policy.CodeInternal && msg == "" {
		msg = "internal error"
	}
	return policy.HTTPStatus(pe.Code), errorBody{ErrorCode: string(pe.Code), Message: msg}
}

func writeError(w http.ResponseWriter, err error) {
	st, b := errBody(err)
	writeJSON(w, st, b)
}

func (a *API) fail(w http.ResponseWriter, r *http.Request, err error) {
	if policy.CodeOf(err) == policy.CodeInternal {
		a.log.Error("internal error", "path", r.URL.Path, "err", err)
	}
	writeError(w, err)
}

func decode(r *http.Request, v any) error {
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(v); err != nil {
		var mbe *http.MaxBytesError
		switch {
		case errors.As(err, &mbe):
			return policy.Errorf(policy.CodeInvalidRequest, "request body too large (max %d bytes)", mbe.Limit)
		case errors.Is(err, io.EOF):
			return policy.New(policy.CodeInvalidRequest, "request body is required")
		default:
			return policy.Errorf(policy.CodeInvalidRequest, "invalid JSON: %v", err)
		}
	}
	if dec.More() {
		return policy.New(policy.CodeInvalidRequest, "unexpected data after JSON body")
	}
	return nil
}

// --- submit ------------------------------------------------------------------

type submitBody struct {
	OrgID       string  `json:"org_id"`
	Channel     string  `json:"channel"`
	Source      string  `json:"source"`
	Destination string  `json:"destination"`
	Text        string  `json:"text"`
	ClientRef   *string `json:"client_ref"`
	CampaignID  *string `json:"campaign_id"`
	RouteID     *string `json:"route_id"`
	Test        bool    `json:"test"`
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func (b *submitBody) request() (pipeline.Request, error) {
	ch := strings.ToUpper(strings.TrimSpace(b.Channel))
	if ch != store.ChannelHTTP && ch != store.ChannelWeb {
		return pipeline.Request{}, policy.New(policy.CodeInvalidRequest, "channel must be HTTP or WEB")
	}
	if b.OrgID == "" {
		return pipeline.Request{}, policy.New(policy.CodeInvalidRequest, "org_id is required")
	}
	return pipeline.Request{
		OrgID: b.OrgID, Channel: ch, Source: b.Source, Destination: b.Destination, Text: b.Text,
		ClientRef: deref(b.ClientRef), CampaignID: deref(b.CampaignID), RouteID: deref(b.RouteID), Test: b.Test,
	}, nil
}

func (a *API) submitOne(ctx context.Context, b *submitBody) (*pipeline.Result, error) {
	req, err := b.request()
	if err != nil {
		return nil, err
	}
	return a.d.Pipeline.Submit(ctx, req)
}

func (a *API) submit(w http.ResponseWriter, r *http.Request) {
	var b submitBody
	if err := decode(r, &b); err != nil {
		a.fail(w, r, err)
		return
	}
	res, err := a.submitOne(r.Context(), &b)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (a *API) submitBatch(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Items []json.RawMessage `json:"items"`
	}
	if err := decode(r, &body); err != nil {
		a.fail(w, r, err)
		return
	}
	if len(body.Items) == 0 {
		a.fail(w, r, policy.New(policy.CodeInvalidRequest, "items must not be empty"))
		return
	}
	if len(body.Items) > a.d.BatchMax {
		a.fail(w, r, policy.Errorf(policy.CodeInvalidRequest, "at most %d items per batch", a.d.BatchMax))
		return
	}
	results := make([]any, len(body.Items))
	idx := make(chan int)
	var wg sync.WaitGroup
	for n := 0; n < min(a.d.BatchPar, len(body.Items)); n++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range idx {
				var b submitBody
				if err := json.Unmarshal(body.Items[i], &b); err != nil {
					_, eb := errBody(policy.Errorf(policy.CodeInvalidRequest, "item %d: invalid JSON: %v", i, err))
					results[i] = eb
					continue
				}
				res, err := a.submitOne(r.Context(), &b)
				if err != nil {
					if policy.CodeOf(err) == policy.CodeInternal {
						a.log.Error("batch item failed", "item", i, "err", err)
					}
					_, eb := errBody(err)
					results[i] = eb
					continue
				}
				results[i] = res
			}
		}()
	}
	for i := range body.Items {
		idx <- i
	}
	close(idx)
	wg.Wait()
	writeJSON(w, http.StatusOK, map[string]any{"results": results})
}

// --- template preview --------------------------------------------------------

func (a *API) preview(w http.ResponseWriter, r *http.Request) {
	var req pipeline.PreviewRequest
	if err := decode(r, &req); err != nil {
		a.fail(w, r, err)
		return
	}
	for _, id := range []string{req.RouteID, req.OrgID} {
		if id != "" {
			if _, err := uuid.Parse(id); err != nil {
				a.fail(w, r, policy.New(policy.CodeInvalidRequest, "route_id and org_id must be uuids"))
				return
			}
		}
	}
	res, err := a.d.Pipeline.Preview(r.Context(), req)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// --- monitoring --------------------------------------------------------------

func (a *API) connStatus(w http.ResponseWriter, r *http.Request) {
	conns := []dispatch.ConnStatus{}
	if a.d.Connections != nil {
		conns = a.d.Connections.Status()
	}
	writeJSON(w, http.StatusOK, map[string]any{"connections": conns})
}

type sessionJSON struct {
	SessionID      string    `json:"session_id"`
	OrgID          string    `json:"org_id"`
	SystemID       string    `json:"system_id"`
	BindType       string    `json:"bind_type"`
	RemoteAddr     string    `json:"remote_addr"`
	BoundSince     time.Time `json:"bound_since"`
	TPSCurrent     float64   `json:"tps_current"`
	SubmittedTotal uint64    `json:"submitted_total"`
}

func (a *API) sessions(w http.ResponseWriter, r *http.Request) {
	out := []sessionJSON{}
	if a.d.SMPP != nil {
		for _, s := range a.d.SMPP.Sessions() {
			out = append(out, sessionJSON{SessionID: s.ID, OrgID: s.OrgID, SystemID: s.SystemID, BindType: s.BindType.String(),
				RemoteAddr: s.RemoteAddr, BoundSince: s.BoundSince.UTC(), TPSCurrent: s.TPSCurrent, SubmittedTotal: s.SubmittedTotal})
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessions": out})
}

func (a *API) kick(w http.ResponseWriter, r *http.Request) {
	var b struct {
		OrgID string `json:"org_id"`
	}
	if err := decode(r, &b); err != nil {
		a.fail(w, r, err)
		return
	}
	if _, err := uuid.Parse(b.OrgID); err != nil {
		a.fail(w, r, policy.New(policy.CodeInvalidRequest, "org_id must be a uuid"))
		return
	}
	n := 0
	if a.d.SMPP != nil {
		n = a.d.SMPP.Kick(b.OrgID)
	}
	writeJSON(w, http.StatusOK, map[string]int{"kicked": n})
}

func (a *API) stats(w http.ResponseWriter, r *http.Request) {
	out := map[string]any{"tps_in": 0.0, "tps_out": 0.0, "queue_depth": int64(0), "connections_up": 0, "connections_total": 0}
	if a.d.Rates != nil {
		out["tps_in"], out["tps_out"] = a.d.Rates.TPSIn(), a.d.Rates.TPSOut()
	}
	if a.d.Connections != nil {
		out["queue_depth"] = a.d.Connections.QueueDepth()
		up, total := a.d.Connections.ConnectionsUp()
		out["connections_up"], out["connections_total"] = up, total
	}
	writeJSON(w, http.StatusOK, out)
}

// --- balances ----------------------------------------------------------------

// tagFor returns the balance hash tag of org: from the snapshot, else from
// the database (an org created since the last reload).
func (a *API) tagFor(ctx context.Context, orgID string) (string, error) {
	if snap := a.d.Store.Current(); snap != nil {
		if o := snap.Org(orgID); o != nil {
			tag, ok := snap.BalanceTag(orgID)
			if !ok {
				return "", policy.New(policy.CodeInvalidRequest, "SUPER_ADMIN has no balance")
			}
			return tag, nil
		}
	}
	if a.d.DB == nil {
		return "", policy.New(policy.CodeNotFound, "organization not found")
	}
	var role, parent string
	err := a.d.DB.QueryRow(ctx, `SELECT role::text, coalesce(parent_id::text, '') FROM organizations WHERE id = $1`, orgID).Scan(&role, &parent)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", policy.New(policy.CodeNotFound, "organization not found")
	}
	if err != nil {
		return "", policy.Wrap(policy.CodeInternal, "database unavailable", err)
	}
	tag := billing.TagFor(role, orgID, parent)
	if tag == "" {
		return "", policy.New(policy.CodeInvalidRequest, "SUPER_ADMIN has no balance")
	}
	return tag, nil
}

func (a *API) credit(w http.ResponseWriter, r *http.Request) {
	var b struct {
		OrgID          string `json:"org_id"`
		DeltaMicros    *int64 `json:"delta_micros"`
		IdempotencyKey string `json:"idempotency_key"`
	}
	if err := decode(r, &b); err != nil {
		a.fail(w, r, err)
		return
	}
	switch {
	case uuid.Validate(b.OrgID) != nil:
		a.fail(w, r, policy.New(policy.CodeInvalidRequest, "org_id must be a uuid"))
		return
	case b.DeltaMicros == nil:
		a.fail(w, r, policy.New(policy.CodeInvalidRequest, "delta_micros is required"))
		return
	case strings.TrimSpace(b.IdempotencyKey) == "" || len(b.IdempotencyKey) > 200:
		a.fail(w, r, policy.New(policy.CodeInvalidRequest, "idempotency_key is required (max 200 chars)"))
		return
	}
	tag, err := a.tagFor(r.Context(), b.OrgID)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	res, err := a.d.Balances.Credit(r.Context(), tag, b.OrgID, *b.DeltaMicros, b.IdempotencyKey)
	if err != nil {
		a.fail(w, r, policy.Wrap(policy.CodeInternal, "credit failed", err))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": res.Status, "balance_micros": res.Balance})
}

func (a *API) balance(w http.ResponseWriter, r *http.Request) {
	orgID := r.PathValue("org_id")
	if uuid.Validate(orgID) != nil {
		a.fail(w, r, policy.New(policy.CodeInvalidRequest, "org_id must be a uuid"))
		return
	}
	tag, err := a.tagFor(r.Context(), orgID)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	info, err := a.d.Balances.Balance(r.Context(), tag, orgID)
	if err != nil {
		if errors.Is(err, billing.ErrNoAccount) {
			a.fail(w, r, policy.New(policy.CodeNotFound, "organization has no balance account"))
			return
		}
		a.fail(w, r, policy.Wrap(policy.CodeInternal, "balance unavailable", err))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"balance_micros": info.Balance, "credit_limit_micros": info.Limit, "loaded": info.Loaded})
}

// --- health ------------------------------------------------------------------

func (a *API) health(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	var dbOK, redisOK bool
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		dbOK = a.d.DB != nil && a.d.DB.Ping(ctx) == nil
	}()
	go func() {
		defer wg.Done()
		redisOK = a.d.Redis != nil && a.d.Redis.Ping(ctx).Err() == nil
	}()
	wg.Wait()
	ok := dbOK && redisOK && a.d.Store.Current() != nil
	status := http.StatusOK
	if !ok {
		status = http.StatusServiceUnavailable
	}
	writeJSON(w, status, map[string]bool{"ok": ok, "db": dbOK, "redis": redisOK})
}

// String is for logs.
func (b *submitBody) String() string { return fmt.Sprintf("org=%s ch=%s", b.OrgID, b.Channel) }

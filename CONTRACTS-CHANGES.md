## engine-core (engine/internal/{config,crypto,phone,otp,billing,store,routing,ratelimit,policy})

All changes below are backward compatible.

1. **New Redis key `bal:dirty`** (SET, engine-owned, addition to §7). Members are `<tag>|<org_id>`.
   Every successful debit/refund/credit adds the org; the balance Syncer `SPOP`s it and writes
   `accounts_balance.balance_micros` + `synced_at`. A full sweep (default every 60s) re-enqueues
   every billable org as a safety net.
2. **`accounts_balance.synced_at` is the Redis server time** (`TIME`, read in the same MULTI as
   the balances). The syncer only updates rows where `synced_at IS NULL OR synced_at < read_time`,
   so two engine instances never overwrite a newer balance with an older one.
3. **Hydration locks the row**: the engine reads `accounts_balance ... FOR UPDATE` and keeps the
   lock while `load.lua` runs. *Recommended api protocol for top-ups (closes the hydrate/top-up
   race):* `BEGIN; SELECT 1 FROM accounts_balance WHERE org_id=$1 FOR UPDATE;` → call
   `POST /internal/v1/balance/credit` → on `NOT_LOADED` do `UPDATE ... balance_micros += delta`
   → `COMMIT`. Without the lock a top-up that races a first-use hydration can be lost.
4. **Billing with no `accounts_balance` row** → `INSUFFICIENT_FUNDS` (debit) / not found (balance read).
5. **MSISDN normalization (§3) is a lenient superset**: besides `+`, spaces and `-`, the engine also
   strips `(`, `)`, `.`, Unicode dashes and any Unicode whitespace (NBSP, tabs). Only one leading
   `+` is accepted. Result rules unchanged (6–15 ASCII digits, else `INVALID_DESTINATION`).
6. **Sender matching (§9 step 5)**: alphanumeric senders compare case-insensitively against
   `sender_ids.sender`; numeric senders compare digits (a leading `+` on either side is ignored).
   Rows in any status make the org "restricted"; only `APPROVED` rows match.
7. **OTP extraction (§9 step 6)**: for each pattern in order, *every* match is checked against
   `[otp_min_len, otp_max_len]` (code points). If a pattern has capturing groups, the OTP is the
   first non-empty group, else the whole match. New migration
   `db/migrations/005_otp_patterns.sql` changes only the column DEFAULT of
   `route_templates.extract_patterns` to six ordered patterns (keyword-anchored first) so that
   amounts/dates before the code ("Pay Rs 2500 ... OTP 772211") are skipped. Existing rows unchanged.
   A `template_mode` route with no active template sends the raw text (SEND_RAW).
   `SEND_DEFAULT_TEMPLATE` without a `default_body` also degrades to SEND_RAW; in a default body
   `{otp}` renders as "".
8. **`cfg:invalidate` handling**: any message (any entity, or malformed JSON) triggers a FULL
   reload in one REPEATABLE READ snapshot, trailing-debounced 200ms and capped at 2s under a
   continuous burst. The engine also reloads after every (re)subscribe and every 60s.
   Future-dated `upstream_rates` take effect on the first reload after `effective_from`.
9. **Route selection (§9 step 4)**: a candidate assignment whose route is disabled, has no usable
   connection (route link + connection enabled, password decryptable), or — for a CLIENT — has no
   enabled reseller assignment on the same route matching the destination is *skipped* and the next
   candidate is tried; only when none remain is `ROUTE_NOT_FOUND` returned. Ties after
   (longest prefix, lowest priority) are broken by route id. SUPER_ADMIN may send only on a forced
   `route_id` (tester), unbilled.
10. **WEB channel**: `app.org_effective_state` has no `can_web`; the engine derives
    `can_web = can_send AND org.web_enabled AND reseller.web_enabled`.
11. **Rate limits (§9 step 8)**: one atomic Lua check across `rl:org:<org>:<unix_sec>` (TTL 2s),
    `cnt:d:<org>:<YYYYMMDD>` and `cnt:m:<org>:<YYYYMM>`. Day/month are computed in the org's
    `timezone` (unknown zone → UTC); TTL = end of local day + 1h / end of local month + 1d. Counters
    count messages (not parts); a rejected check increments nothing. Requires a non-cluster Redis
    (the three keys share no hash tag, as named in §7).
12. **HTTP status for error codes** (`policy.HTTPStatus`): 400 INVALID_REQUEST, 401 UNAUTHORIZED,
    403 FORBIDDEN / IP_NOT_ALLOWED, 404 NOT_FOUND, 409 CONFLICT, 429 RATE_LIMITED, 500 INTERNAL,
    422 for every other business rejection. SMPP bind: unknown system_id → ESME_RINVSYSID,
    disallowed bind type → ESME_RBINDFAIL.

## api part 1 (api/: foundation, auth, management)

All changes below are backward compatible additions or clarifications of §10.

1. **Login with 2FA**: correct password + TOTP enabled + no `totp_code` → `200 {"requires_totp": true}`
   (no tokens). `totp_code` accepts a 6-digit TOTP (±1 step) or a one-time recovery code
   (`xxxxx-xxxxx`). Failed codes count toward the lockout (5 consecutive failures → 15 min lock;
   401 with `details.locked_until`). Suspended org (own or reseller) → `403 ACCOUNT_SUSPENDED`;
   panel IP outside a `PANEL`/`ALL` whitelist → `403 IP_NOT_ALLOWED`.
2. **Token responses** add `token_type: "Bearer"`, `expires_in: 900`. JWTs carry `iss=smsgw-api`,
   `aud=smsgw`, `jti`. While impersonating, `sub` stays the real user and `imp == sub`.
   Every request re-validates the token against the DB (user active, `iat` ≥ password change,
   acting org active unless impersonating → `ACCOUNT_SUSPENDED`).
3. **`POST /api/auth/password`** returns a fresh `{access_token, refresh_token}` and revokes all other
   sessions (older access tokens stop working). Password / 2FA changes are refused while impersonating.
   `POST /api/auth/impersonate` is decided on the user's *real* org (admin → any reseller/client,
   reseller → own clients); `stop` revokes impersonation refresh tokens. Reusing ANY revoked refresh
   token (rotated or logged out) revokes the whole family.
4. **Balance**: `topup`/`adjust` accept an optional `idempotency_key` (body) or `Idempotency-Key`
   header; a replay returns the same ledger row (`replay: true`), a mismatched replay is 409.
   Response: `{transaction, status: "OK"|"DUPLICATE"|"NOT_LOADED", replay}`. Credit + apply run in
   one transaction holding `accounts_balance … FOR UPDATE` (engine-core #3). Engine unreachable →
   `502 INTERNAL` with `details: {transaction_id, applied: false}`; a reconciler (privileged pool,
   every `LEDGER_RECONCILE_INTERVAL_MS`, default 30s) retries unapplied rows older than 60s with the
   same key. `GET /api/orgs/:id/balance` adds `source: "engine"|"database"` (live engine value when
   reachable). SUPER_ADMIN has no balance (404).
5. **Invalidation**: channel name is configurable via `CFG_INVALIDATE_CHANNEL` (default
   `cfg:invalidate`; tests use a private channel because pub/sub ignores the Redis DB index).
   Messages are published only after the DB transaction commits. Replace-set endpoints
   (`PUT /api/orgs/:id/routes`, `PUT /api/routes/:id/connections`, `PUT /api/connections/:id/rates`)
   publish `id: null`.
6. **Orgs**: `PATCH /api/orgs/:id` by the org itself may change only `brand_name`, `timezone`,
   `whitelabel_domain` (resellers only); everything else is parent-only. `POST /api/orgs` also accepts
   `timezone`. Suspending/disabling SMPP of a RESELLER also kicks its clients' sessions (their
   effective state changes too). Org list items add `balance` and `child_count`; `GET /api/orgs/:id`
   returns `effective_state` (true values, computed with the privileged pool) and `counts`.
7. **Route assignments**: a reseller may assign only routes it has (403, `details.route_id`) and,
   for enabled rows, only prefixes that start with one of its own prefixes for that route (400,
   `details.allowed_prefixes`). `parent_rate_micros` = parent's enabled assignment on the same route
   with the longest prefix covering the row's prefix; shown only to the parent/admin (null for the
   org itself and for resellers).
8. **Sender IDs**: created by the parent org → `APPROVED` immediately; by the org itself → `PENDING`.
   Numeric senders are stored without `+`. `GET /api/sender-ids?include_children=true` lists all
   direct children's rows (approval queue).
9. **Templates**: admin creates/edits only route-wide templates (`org_id` null); a reseller only
   per-client overrides of its clients on routes assigned to it/the client; clients read only their
   effective template per assigned route. Preview for a CLIENT always uses `org_id = self`.
10. **Webhooks**: `PATCH` accepts `rotate_secret: true` (returns the new `secret` once). The test
    endpoint posts the §9 DLR payload plus `"test": true` with the §2 signature, logs a
    `webhook_deliveries` row (`attempt: 1`, `message_id: null`) and returns
    `{ok, status_code, duration_ms, error, response_body, delivery_id, payload}`. `events` ⊆ `["dlr"]`.
11. **Blocklist**: the admin acting on itself manages the GLOBAL list (`org_id NULL`); keyword
    patterns must be RE2-safe (no look-around, backreferences, atomic groups, possessive
    quantifiers, recursion) and valid. Number prefixes are normalized (strip `+`, spaces, dashes).
12. **IP whitelist**: a bare IP is stored as `/32` (`/128`); CIDRs with host bits set are 400 (with a
    suggestion). Adding a `PANEL`/`ALL` rule for your own org that would exclude your current IP is 400.
13. **Connections**: responses include `has_password: true`; `password_enc` is never returned and
    never written to audit rows. API key `scopes` ⊆ `["sms:send","sms:read","balance:read"]`.
14. **Audit rows**: `actor_user_id` = real user, `actor_org_id` = acting org (impersonated org while
    impersonating — required by RLS), `impersonator_user_id` = `imp`. `GET /api/audit-logs` also
    accepts `entity_type` and `action=<prefix>*`.
15. **HTTP statuses** for api-raised errors use the engine-core #12 mapping (422 for business
    rejections incl. ACCOUNT_SUSPENDED/SENDING_DISABLED/CHANNEL_DISABLED/DAILY_LIMIT/MONTHLY_LIMIT),
    except panel auth: a suspended org at login / on a management request is `403 ACCOUNT_SUSPENDED`.
    Engine 4xx errors proxied through `EngineClient` keep the engine's status and `error_code`.

## web part 1 (web/: foundation, auth, admin + reseller + settings pages)

All items are backward compatible. Item 1 asks the api for an addition; the web works without it.

1. **Effective brand on `GET /api/auth/me` (requested, optional).** The web reads an optional
   top-level `brand_name: string | null` = the acting org's `brand_name`, else its reseller's
   `brand_name`. It renders this as the whitelabel brand in the panel header. If the field is absent,
   the web falls back to `org.brand_name`, then "SMS Gateway". A client can't read its reseller's
   row under RLS, so the api has to provide this value (privileged lookup, as with `effective_state`).
2. **`API_URL` is a build-time setting for web.** `next.config.mjs` rewrites `/api/*` and `/v1/*`
   to `API_URL` (default `http://localhost:3000`). Next.js serializes rewrite destinations at
   `next build`, so deploy scripts must pass `API_URL` to the build step, not just to `next start`.
   The web listens on 3001.
3. **Top-up / adjust idempotency.** The web sends `idempotency_key: "web-<uuid>"`, one per dialog
   session, so double-submits and retries are replays (api part 1 #4). A `502` whose
   `details.transaction_id` is set is shown as "recorded, pending" and not as a failure.
4. **Audit-log filters.** The UI searches actions by prefix. It sends `action=<prefix>*`, plus
   `from`/`to` as ISO instants: local midnight of the picked day, and for `to` the next day's local
   midnight, which is exclusive.
5. **Password change.** After `POST /api/auth/password` the web stores the returned token pair
   before refetching, because the old tokens are revoked.
6. **Lists.** The web never sends `page_size` > 200 and does not send `sort`/`order`. Set-style
   endpoints are read as `{items}`, and bare arrays are also accepted.

## api part 2 (api/: /v1, messages, analytics, tester, campaigns, dashboard, alerts)

All changes below are backward compatible additions or clarifications of §10/§11.

1. **`/v1` authentication order & statuses**: key missing/malformed/unknown/revoked/expired → `401 UNAUTHORIZED`;
   org (or its reseller) not active → `422 ACCOUNT_SUSPENDED`; `can_send` false → `422 SENDING_DISABLED`;
   `can_api` false → `422 CHANNEL_DISABLED`; IP outside an `API`/`ALL` whitelist → `403 IP_NOT_ALLOWED`;
   then the per-key rate limit → `429 RATE_LIMITED` (+ `Retry-After: 1`, `X-RateLimit-Limit/Remaining`).
   `?api_key=` is accepted on GET only. A panel JWT is not accepted on `/v1`.
2. **API key scopes are enforced**: send needs `sms:send`, `GET /v1/sms/:id` needs `sms:read`,
   `GET /v1/balance` needs `balance:read` **or** `sms:send` (default keys can read their balance) → else `403 FORBIDDEN`.
3. **New Redis key (api-owned)** `rl:apikey:<api_key_id>:<unix_sec>` (INCR, TTL 2s) — per-key limit,
   `PUBLIC_API_RATE_LIMIT` (default 100/s). Fails open if Redis is unreachable.
   **New Redis keys (api-owned)** `alert:low_balance:<org_id>` and `alert:route_down:<admin_org_id>:<route_id>`
   (`SET NX EX`, default 6h) — alert de-duplication.
4. **Send**: a `to` string may contain several numbers separated by `,` `;` or newlines. Destinations are
   normalised by the api with the engine-core #5 rules before submission; invalid ones never reach the engine
   (`INVALID_DESTINATION` row, or 422 for a single recipient). Result `to` is the normalised number (the raw
   input for invalid rows). `POST /v1/sms/send` returns 200; `POST /api/messages/send` returns 201 (same body).
   `POST /api/messages/send` is allowed for RESELLER and CLIENT (acting org), channel WEB.
5. **`GET /v1/sms/:id`** returns only messages of the key's own org (a reseller key does not see its clients').
   `done_at` = `message_logs.dlr_received_at`; `cost_micros` = `client_cost_micros`.
   **`GET /v1/balance`** falls back to the synced `accounts_balance` snapshot when the engine is unreachable.
6. **`GET /api/messages`**: `from_date`/`to_date` accept `YYYY-MM-DD` (UTC day; a date-only `to_date` includes
   that day) or ISO date-times; default last 7 days, max 366 days. `status` accepts a comma list. `destination`
   = exact number when it normalises to a full MSISDN, else a digit prefix. `source` is case-insensitive (`+` ignored
   for numeric). `q` matches id / client ref exactly or text (ILIKE). Extra filter `campaign_id`. `limit` 1-500
   (default 50). `next_cursor` is opaque. `org_id` of a RESELLER = its whole tree (own + clients').
   Items use `message_logs` column names plus `org_name`, `route_name`, `connection_name`; costs the role must
   not see are `null` (client: only `client_*`; reseller: + `reseller_cost_micros`; admin: all incl. `route_cost_micros`,
   `connection_*`, `smsc_msg_ids`).
7. **CSV export**: UTF-8 with BOM, CRLF rows, RFC 4180 quoting; free-text cells starting with `= + - @ TAB CR`
   are prefixed with `'` (formula-injection guard). Money columns are decimal currency units with 6 decimals
   (`cost`; `reseller_cost` for reseller/admin; `route_cost` for admin). Max 1,000,000 rows (`X-Export-Max-Rows`).
8. **Analytics money per role** (acting role): admin revenue = Σ`reseller_cost`, cost = Σ`route_cost`;
   reseller revenue = Σ`client_cost` of its **clients'** rows (its own sends add no revenue), cost = Σ`reseller_cost`
   (incl. own sends) — *engine: for a RESELLER's own sends record the debited amount in `reseller_cost_micros`*;
   client: `revenue_micros = 0`, `cost_micros` = Σ`client_cost`, `profit_micros = 0`, plus `spend_micros`.
   `failed` = undelivered + failed + rejected + expired; `pending` = messages − delivered − failed;
   `delivery_rate` is a 0..1 ratio (4 decimals). `from`/`to` default to the last 7 days (max 400; hourly series max 31).
   Timeseries add `date`, `cost_micros` (and `spend_micros` for clients) per point, fill gaps with zeros, and
   return `granularity` and `timezone`; `granularity=day` buckets by calendar day in `?tz=` or the covered org's
   (else acting org's) `organizations.timezone`; `hour` buckets are UTC. Breakdown `by=org` for the admin over
   everything groups by reseller tree; otherwise by org. `by=status` rows (`DELIVERED|UNDELIVERED|FAILED|REJECTED|EXPIRED|PENDING`)
   carry `share` and money 0 (not attributable from rollups). Rows add `profit_micros` (or `spend_micros` for clients).
9. **`/api/analytics/live`** (admin): `tps_out`/`queue_depth`/connections from engine status; `tps_in` = rate of
   `smsgw_submit_total` from the engine Prometheus endpoint (`ENGINE_METRICS_URL`, default `<ENGINE_URL host>:9100/metrics`),
   `null` when unreachable; adds `inflight`, `connections_enabled`.
10. **Tester**: SUPER_ADMIN and RESELLER only; the route must be visible to the caller (404). Audited as `tester.send`.
    Timings add `total_latency_ms`.
11. **Campaigns**: RESELLER/CLIENT create for the acting org. CSV: header row must contain `phone`
    (case/spacing-insensitive); delimiter `,` `;` or TAB; other columns become `{column}` variables (names
    lower-cased, non-alphanumerics → `_`); phones normalised and de-duplicated; max 100,000 recipients; upload
    ≤ 25 MB (JSON bodies are limited to 2 MB — use CSV for large lists). Unknown `{placeholders}` → 400. Response adds
    `pending` and `import: {columns, invalid_rows, duplicate_rows, errors[≤20]}`. Status: no `scheduled_at` → DRAFT,
    else SCHEDULED. `start`: DRAFT/SCHEDULED/PAUSED → RUNNING; `pause`: SCHEDULED/RUNNING → PAUSED; `cancel`:
    DRAFT/SCHEDULED/RUNNING/PAUSED → CANCELLED; other transitions → 409. Extra: `GET /api/campaigns/:id/recipients?state=pending|submitted|failed`.
    Worker: chunks of `effective_max_tps` (≤1000) per second per campaign via `/submit/batch` (channel WEB,
    `campaign_id` set); per-recipient errors are stored in `campaign_recipients.error_code`; RATE_LIMITED / engine
    outage → retried; org-level rejections (INSUFFICIENT_FUNDS, ACCOUNT_SUSPENDED, SENDING_DISABLED, CHANNEL_DISABLED,
    DAILY_LIMIT, MONTHLY_LIMIT) → campaign PAUSED (audit `campaign.auto_pause` with `reason`), recipients stay pending.
    Ends COMPLETED, or FAILED when nothing was submitted. At-least-once per chunk on a crash mid-chunk.
12. **Dashboard** adds `timezone`; `last7d[]` items: `{date, messages, delivered, failed, revenue_micros, cost_micros}`
    (client: `spend_micros` instead). Counts — admin: `resellers, clients, routes, connections_total, connections_up`
    (`null` if the engine is unreachable); reseller: `clients, routes`; client: `routes, api_keys, campaigns_active`.
13. **Alerts**: low balance when `balance + credit_limit ≤ low_balance_alert_micros` (live engine balance when
    reachable); route down when an enabled route has no enabled connection in state BOUND. Recipients:
    `notification_settings.email_to`, else the org's active users; Telegram when enabled with a chat id.
14. **Monitor**: `GET /api/monitor/smpp-sessions` items add `org_name` for every role.
15. **OpenAPI**: Swagger UI `/api/docs`, JSON `/api/docs-json` (disable with `SWAGGER_ENABLED=0`).

## engine-flow (engine/internal/{pipeline,dispatch,dlr,cdr,webhook,internalapi,metrics,app}, cmd/engine, cmd/smpp-cli, e2e)

All changes below are backward compatible additions or clarifications.

1. **New endpoint `GET /internal/v1/stats`** (X-Internal-Token) →
   `{ "tps_in": n, "tps_out": n, "queue_depth": n, "connections_up": n, "connections_total": n }` —
   the numbers behind `/api/analytics/live` (tps_in = messages accepted during the last full second,
   tps_out = PDUs submitted upstream during the last full second, queue_depth = entries in all
   `q:dispatch:*` streams, connections over enabled upstream connections).
2. **`GET /internal/v1/health`** answers HTTP 503 (same JSON body) when `ok` is false.
3. **CDR writes are asynchronous** (batched every `ENGINE_CDR_FLUSH_INTERVAL`, default 250 ms): a
   `message_logs` row can appear up to ~one flush interval after the submit response. During a
   database outage operations stay queued in memory (submits block once `20000` are pending) and
   are written when Postgres is back; only on a hard crash can queued CDR operations be lost.
4. **Status transitions are monotonic** (ACCEPTED < QUEUED < SUBMITTED < final; the first final
   status wins). `error_code` values written by the engine: SMPP status names from submit_sm_resp
   (e.g. `ESME_RSUBMITFAIL`, `ESME_RTHROTTLED`), `SUBMIT_TIMEOUT`, `NO_SESSION`, `SUBMIT_ERROR`,
   `ENCODING_ERROR`, `ROUTE_UNAVAILABLE` (route deleted/disabled while queued),
   `NO_CONNECTION_AVAILABLE` (no bound connection for 10 min), `ENQUEUE_FAILED`.
   SMPP submissions store `client_msg_ref` = the message id returned in submit_sm_resp.
5. **`message_stats_hourly` semantics**: bucket = hour of `created_at` (UTC); `messages`/`parts`
   counted at insert; `submitted` +1 when `submitted_at` is first set; `delivered … expired` hold the
   message's *current* final status (moves between counters, never double counted);
   `client_cost_micros`/`reseller_cost_micros` exclude fully refunded messages and reflect partial
   refunds; `country_iso` from the destination ('--' unknown). `reseller_cost_micros` for a message
   sent by a RESELLER itself equals its own charge (admin revenue). SUPER_ADMIN tester traffic has
   NULL costs.
6. **Multipart partial failure**: if part 1 is rejected upstream the whole message fails over; if a
   later part is rejected the message stays SUBMITTED on that connection, the rejected parts'
   share is refunded (`client/reseller_cost_micros` reduced accordingly) and those parts count as
   FAILED in the final DLR aggregation (severity DELIVERED < UNKNOWN < EXPIRED < UNDELIVERED <
   REJECTED < FAILED). With `multipart_mode = PAYLOAD` one PDU (one DLR) carries the whole message.
7. **Redis additions (§7)**:
   `msg:<id>` also holds `src, dst, rd (client registered_delivery), text (first 20 chars), route_id,
   connection_id, pdus, submitted_ms, done, status, s<i>/e<i> (per-part status / "stat|err")`.
   `dlrmap` part index is **0-based**; keys use `NormalizeMessageID(smsc id)` (receipts are matched
   with the hex/decimal variants). `q:dispatch:<route>` entries carry one field `j` (JSON job);
   entries are XACK+XDEL'd when handled. `q:dlr-out` (consumer group `dlr-out`) entries carry field
   `e` (JSON event). Webhook queue: `wh:due` (ZSET), `wh:job:<webhook>:<event>:<message>` (HASH),
   `wh:sent:<…>` (dedup marker, 72 h).
8. **Client DLR forwarding**: a FAILED message (nothing accepted upstream) is reported to SMPP
   clients as a receipt with `stat:REJECTD` and to webhooks with `"status":"FAILED"`,
   `"dlr_stat":"REJECTD"`, `"submitted_at":null`. Webhook `client_ref` is `null` for SMPP traffic.
   Webhooks are sent for every channel whose org has an enabled `dlr` webhook. SMPP receipts honour
   the client's `registered_delivery` (0 none, 1 always, 2 failures only) and are retried every
   ~30 s while no RX/TRX session is bound, for up to 72 h. Webhook requests also carry
   `X-Webhook-Event` and `X-Webhook-Delivery` headers; redirects are not followed (count as failure).
   `webhooks.failure_count` counts *consecutive* failed attempts (reset to 0 on success);
   `max_retries` = retries after the first attempt (delays 10 s·2^(n-1), capped at 6 h).
9. **Upstream encoding**: GSM-7 text is sent with data_coding 0 (GSM 03.38 unpacked) unless the
   connection's `default_data_coding` is 1 (IA5) and the text is plain ASCII; other values fall back
   to 0. UCS-2 is data_coding 8. Destination TON 1 / NPI 1. `registered_delivery` = 1 iff
   `request_dlr`. Per-connection token bucket = `max_tps` with burst max(1, max_tps/10).
10. **Client SMPP server**: a session-sweeper unbinds sessions within ~5 s when the org/account can
   no longer use SMPP (suspension, SMPP disabled, account disabled/removed) even without an api
   kick. Per-session submit TPS = effective org TPS (lowered by smpp_accounts.max_tps); the per-org
   Redis limiter still applies across sessions. `ENGINE_SMPP_MAX_SESSIONS` caps binds server-wide
   (`ESME_RBINDFAIL`). Successful binds update `smpp_accounts.last_bind_at/last_bind_ip`.
11. **Refund when the Redis balance is gone** (refund.lua NOT_LOADED after a hydration retry): the
   engine inserts a `balance_transactions` row (type REFUND, idempotency_key
   `refund:<message_id>:<org_id>`, applied_at set) and adds the amount to `accounts_balance`.

## web part 2 (web/: send, campaigns, messages, analytics, monitor, tester, API & SMPP, dashboard charts)

All items are backward compatible; they describe how the web uses the §10 endpoints.

1. **Monitor for resellers.** `/monitor` is now in the RESELLER nav and route access. A reseller sees
   only `GET /api/monitor/smpp-sessions` (its clients' sessions) and a live TPS derived from the sessions'
   `tps_current`; `GET /api/monitor/connections` and `/api/analytics/live` are called for SUPER_ADMIN only.
2. **Time ranges.** Reports and analytics send `from`/`to` (`from_date`/`to_date` for messages) as ISO
   instants of the viewer's local midnight, `[from, to)`. Day-granularity timeseries add
   `tz=<viewer IANA zone>` (api part 2 #8) and match points by their `date` field; hourly series are
   requested only for ranges ≤ 7 days.
3. **Role money.** The web follows api part 2 #8: for a CLIENT "Spend" = `spend_micros ?? cost_micros`
   (revenue is 0); reseller/admin show revenue, cost (labelled "Wholesale cost" / "Upstream cost") and
   profit. Status breakdown rows show counts and `share` only (no money).
4. **Campaign uploads.** If the chosen phone column's normalized name is not `phone`, the web re-serializes
   the CSV with that column renamed to `phone` (any other column normalizing to `phone` becomes
   `phone_original`) before the multipart upload. Pasted lists are sent as JSON up to 20,000 numbers and
   as a generated one-column CSV upload above that (JSON bodies are capped at 2 MB). `{placeholders}` are
   offered and validated with the api's normalization (`First Name` → `{first_name}`); unknown ones block
   the wizard (the api would return 400).
5. **Quick send** (`POST /api/messages/send`) is chunked by the web into requests of ≤1,000 recipients (cap
   10,000 per page action). A single-recipient rejection (4xx error body) is shown as that recipient's
   result row; an org-level rejection (INSUFFICIENT_FUNDS, ACCOUNT_SUSPENDED, SENDING_DISABLED,
   CHANNEL_DISABLED) stops the remaining chunks.
6. **Cost estimates** in Send / campaign review use `GET /api/orgs/:own_id/routes` with the engine's
   selection rule (enabled, longest prefix, then lowest priority; forced `route_id` restricts) × parts. They
   are estimates: route health and templates (which can change the part count) are not known to the web.
7. **Docs host.** The API & SMPP page shows `NEXT_PUBLIC_API_BASE_URL` (default: the panel origin, which
   proxies `/v1`) and `NEXT_PUBLIC_SMPP_HOST:NEXT_PUBLIC_SMPP_PORT` (default: panel hostname, 2775).

## deployment (deploy/**, Makefile)

All items are backward compatible additions. No other component's code was changed.

1. **`public.schema_migrations`** (filename PK, sha256 `checksum`, `applied_at`) is created and owned
   by `deploy/migrate.sh`. It is not part of `db/migrations`. Each file and its row commit in the
   same transaction: the INSERT is injected before the file's last top-level `COMMIT;`, or the file
   is wrapped in BEGIN/COMMIT when it has none. Applied files must never be edited, because a
   checksum mismatch aborts the run. A file containing the line `-- migrate:no-transaction` runs
   as-is, for `CREATE INDEX CONCURRENTLY`. Databases built by `db/reset-db.sh` have no rows; run
   `MIGRATE_BASELINE=1 deploy/migrate.sh` once to record them.
2. **Production login roles** (`deploy/init/init-roles.sh`) are the production equivalent of
   `db/dev-roles.sql`:
   - `$SMS_API_DB_USER` (default `sms_api_login`): LOGIN, member of `sms_api`, NOBYPASSRLS. Used by
     the api `DATABASE_URL`.
   - `$SMS_ENGINE_DB_USER` (default `sms_engine_login`): LOGIN BYPASSRLS, member of `sms_engine`.
     Used by the engine `DATABASE_URL` and the api `DATABASE_URL_PRIVILEGED`.

   Passwords come from env. Every run resets them and the role attributes, so changing a password
   and re-running rotates it. The script also runs `REVOKE CONNECT, TEMPORARY ON DATABASE … FROM
   PUBLIC`.
3. **Redis in production requires a password**: `REDIS_URL=redis://:<pw>@redis:6379/0`, which both
   go-redis and ioredis parse. It is a single node with AOF everysec and `noeviction`, not Cluster,
   because of engine-core #11.
4. **Web standalone output needs no web/ change.** `web/next.config.mjs` already emits
   `output: 'standalone'` when `NEXT_OUTPUT=standalone` is set at build time, and
   `deploy/web.Dockerfile` sets it. `API_URL` (`http://api:3000` in compose) and the
   `NEXT_PUBLIC_*` values are Docker build args (web part 1 #2). Changing them means rebuilding the
   web image.
5. **Native dev stack** (`deploy/dev-up.sh`) uses Postgres DB `sms_dev` and Redis DB **6** on :6399.
   The engine binds 127.0.0.1:8081 / 127.0.0.1:9100 and :2775. smsc-sim uses :2776 / :2777, the api
   :3000 and the web :3001. Runtime state lives in `deploy/.run/` (git-ignored): PIDs, logs,
   binaries, generated dev secrets and demo credentials. The engine's pub/sub channel is the
   default `cfg:invalidate`, which is not scoped by Redis DB.
6. **Test fixtures used by `make test`.** Each one can be overridden on the make command line:
   - `test-db`: `sms_schema_test`
   - `test-migrate`: `sms_migrate_test`, created empty and dropped afterwards
   - `test-lua`: Redis DB 15
   - `test-go`: `sms_core` + Redis 1 for packages whose tests name `sms_core`; `sms_flow` + Redis 2
     for all other packages, including e2e (`deploy/test-go.sh` sets `TEST_*` / `E2E_*`)
   - `test-api`: `sms_api2` + Redis 5, hard-coded in `api/test/env.ts`
7. **Observed (engine, not changed):** in SMPP receipts forwarded to clients, `submit date` is
   rendered in UTC but `done date` in the host's local time zone. On a host at UTC+2 a receipt read
   `submit date:2610180858 done date:2610181058` for a message delivered within a second. Docker
   images run in UTC, so production containers are unaffected. A native deploy on a non-UTC host
   should set `TZ=UTC` for the engine, or the engine should use one zone for both fields.
8. **dev-up ports are overridable** (defaults unchanged, CONTRACTS §1). `DEV_PORT_OFFSET=<n>` adds
   `n` to every dev port, and `DEV_API_PORT`, `DEV_WEB_PORT`, `DEV_ENGINE_HTTP_PORT`,
   `DEV_SMPP_PORT`, `DEV_METRICS_PORT`, `DEV_SIM_PORT` and `DEV_SIM_HTTP_PORT` set single ports. The
   values used are written to `deploy/.run/ports.env`, and `deploy/dev-demo.sh` reads that file. The
   engine's Redis pub/sub channel `cfg:invalidate` has no env setting (only the in-process
   `app.Overrides.InvalidateChannel` used by tests), and pub/sub
   ignores the Redis DB index, so stacks sharing one Redis server see each other's invalidations.
   That only causes extra full reloads from each engine's own DB. A configurable engine channel,
   matching the api's `CFG_INVALIDATE_CHANNEL`, would be a small engine follow-up.
9. **`make test-deploy`** (`deploy/validate.py`) also runs shellcheck on the deploy scripts when
   `shellcheck` is on PATH or `SHELLCHECK=/path` is set. `deploy/e2e.sh` belongs to the integration
   suite: it is only syntax-checked (`bash -n`, executable bit), with no style rules.
10. **`make test-migrate`** also runs db-init's other two steps on its throwaway DB. First
    `deploy/init/init-roles.sh` runs twice (create, then password rotation), with role names
    `sms_migratetest_api` / `sms_migratetest_engine` (`ROLES_TEST_API` / `ROLES_TEST_ENGINE`). These
    are separate from the shared dev roles because roles are cluster-wide, and they are dropped
    afterwards. Then `deploy/init/maintenance.sh` runs with `MAINT_PARTITION_MONTHS=6`. The test
    checks RLS / BYPASSRLS membership, that the old password is rejected, and that the
    6-months-ahead partition exists.

## integration (deploy/e2e.sh, deploy/e2e/; fixes found by the live end-to-end run)

All items are backward compatible additions.

1. **smsc-sim `-accept-all` / `SMSC_SIM_ACCEPT_ALL=1`**: disables the `…1111` → `ESME_RSUBMITFAIL`
   rule (that destination is delivered normally). The e2e stack runs a second simulator with it, so
   failover from a rejecting first-priority connection to a *succeeding* second one is tested live.
   Default behaviour is unchanged.
2. **New engine endpoint `POST /internal/v1/config/reload`** (X-Internal-Token, empty body) →
   `200 {"version": n}`; a synchronous full config reload (`store.Load`). `500 INTERNAL` if the reload
   fails (the previous snapshot keeps serving). The api calls it (best effort, after commit, before
   any kick) on every org state change: `POST /api/orgs/:id/suspend|activate` and
   `PATCH /api/orgs/:id/channels`. Reason: `cfg:invalidate` is debounced (engine-core #8), and the e2e
   run showed a suspended client could still bind SMPP and get a submit_sm accepted (and billed) in
   that window, and a re-enabled client got `SENDING_DISABLED` for a moment. With several engine
   instances only the one behind `ENGINE_URL` reloads synchronously; the others still apply the
   change on the pub/sub reload.
3. **`PATCH /api/orgs/:id/channels` with `sending_enabled: false`** now kicks the org's SMPP sessions
   too (previously only `smpp_enabled: false`). A bind needs `can_send` (CONTRACTS §4:
   SENDING_DISABLED → `ESME_RINVSYSID` at bind), so sessions must not stay bound until the engine's
   ~5 s sweeper (engine-flow #10) catches them.
4. **smpp-cli `-exit-on-unbind`**: while waiting for a receipt, stop as soon as the gateway closes the
   session; the JSON result then has `"unbound": true` and `error` set. Without the flag the client
   keeps reconnecting until `-wait` expires (unchanged).
5. **Config propagation is eventually consistent** for everything else (routes, assignments, rates,
   templates, credentials): the engine applies it within the debounce (~200 ms + reload time) after
   the api response. `deploy/e2e.sh` waits for upstream binds (`GET /api/monitor/connections`) before
   sending. Org state is the exception (item 2).

## db fixer: RLS hardening (migration 006_rls_hardening.sql)

- `refresh_tokens` now has RLS for `sms_api`: a row is visible only when its user is visible (`app.can_see_org(users.org_id)`). `sms_api` loses INSERT/DELETE on it and SELECT on `token_hash`. It keeps SELECT on every other column and UPDATE on `(revoked_at, revoked_reason)`, which is what the tenant-pool session revocation in orgs.service needs. Auth flows already use the privileged pool, so nothing else changes.
- `message_logs` partitions, including `message_logs_default`, now have RLS enabled with no policy, and `sms_api` has no grants on them. Tenant queries must go through the parent `message_logs`, which already worked that way. `sms_engine` (BYPASSRLS) keeps its grants. `app.ensure_message_log_partitions` locks every new partition in the same way through the new owner-only `app.lock_message_log_partition(regclass)`.
- EXECUTE on `app.ensure_message_log_partitions`, `app.drop_message_log_partitions` and `app.lock_message_log_partition` is revoked from PUBLIC, `sms_api` and `sms_engine`. Only the schema owner runs them (deploy/init/maintenance.sh already connects as the owner).

## deploy fixer: client IP behind proxies, API keys in nginx logs

- **CONTRACTS §11 "client IP from `X-Forwarded-For` first hop if `TRUST_PROXY=1`" is tightened.** With `TRUST_PROXY=1` the api now believes `X-Forwarded-For` only when the socket peer is in the new `TRUSTED_PROXIES` (CIDRs, IPs, or `loopback`/`linklocal`/`uniquelocal`; default `loopback,linklocal,uniquelocal`). It walks the chain `[XFF hops..., peer]` from the right and uses the first address that is not a trusted proxy (a malformed hop stops the walk). Before, `X-Forwarded-For: 127.0.0.1, 8.8.8.8` sent by 8.8.8.8 passed a 127.0.0.1/32 PANEL or API whitelist. Behind a single nginx that replaces the header, the result is the same as before. `TRUST_PROXY=0` is unchanged (peer only). Express `trust proxy` uses the same set, so `req.ip` agrees. (api/src/common/request.util.ts, api/src/config/config.ts)
- **deploy defaults:** web 3001 and api 3000 are now published on `PUBLISH_ADDR` default `127.0.0.1` (was `0.0.0.0`), and in `.env.example`. SMPP 2775 has its own `SMPP_PUBLISH_ADDR` (default `0.0.0.0`, as before), so SMPP stays public and the engine still sees real peers. The api service gets `TRUSTED_PROXIES`. If you previously relied on `PUBLISH_ADDR=0.0.0.0` for SMPP behind nginx's stream block, set `SMPP_PUBLISH_ADDR=127.0.0.1` instead.
- **nginx access log:** `log_format main` logs `$request_log`, which is `$request` with the query string replaced by `[redacted]` whenever it contains `api_key` (any case, or percent-encoded `api%5Fkey`), so legacy `GET /v1/sms/send?api_key=...` keys are not written to disk. `deploy/validate.py` runs `nginx -t` on a copy and a live nginx to verify this.

## api fixer: review findings (auth, parent controls, SSRF, idempotent sends, display fields)

Migration `db/migrations/006_api_security_fixes.sql` (additive columns only, with backfill):
`blocked_numbers/blocked_keywords/ip_whitelists.created_by_org_id`, `smpp_accounts.locked_by_parent`,
`users.totp_last_step`, `campaign_recipients.attempt_message_id`, `campaigns.last_chunk_at`.

1. **Sessions are re-validated on every request AND on refresh** (supersedes api part 1 #2 "org active
   unless impersonating"). The user's REAL org must be active also while impersonating, the
   impersonation must still be allowed (target is a direct child of the real org), and the client IP
   must pass the real org's `PANEL`/`ALL` whitelist (previously login only). Failures: `403
   ACCOUNT_SUSPENDED`, `403 IP_NOT_ALLOWED`, `401` for an impersonation that is no longer allowed. A
   refresh refused for the IP (or a no-longer-allowed impersonation) revokes the token family.
   Suspending an org revokes its users' impersonation refresh tokens. This also covers
   `POST /api/messages/send` (WEB channel). While impersonating, the impersonator's (real org's) IP
   rules apply, not the client's.
2. **`POST /api/auth/impersonate`: SUPER_ADMIN → its RESELLERs only** (was: also any CLIENT; api part 1 #3).
   The admin reaches a client by impersonating its reseller. A real org that is suspended can't
   impersonate.
3. **2FA / password re-checks count toward the lockout**: wrong codes on `POST /api/auth/totp/disable`
   and wrong `current_password` on `POST /api/auth/password` increment `failed_login_count` (5 → 15 min
   lock, `401` with `details.locked_until`); a locked account is refused there too. Each TOTP time step is
   accepted once (`users.totp_last_step`): a code can't be replayed, nor an older step used after a newer one.
4. **User management is parent-only**: `POST /api/orgs/:id/users/:uid/reset-password` and
   `PATCH /api/orgs/:id/users/:uid {is_active}` need the direct parent (directly or while impersonating
   the org) → `403` for the org itself. `full_name` stays editable by the org. Self-service password
   change is `POST /api/auth/password`.
5. **Controls the parent sets on a child can't be undone by the child** ("parent" = the direct parent,
   also while impersonating the child):
   - sender IDs: the org may delete only its own `PENDING` requests; reviewed (approved / rejected) or
     parent-created rows → `403` (any row makes the org sender-restricted in the engine). A sender ID the
     parent creates while impersonating is `APPROVED` like a direct parent create.
   - blocklist numbers / keywords and IP whitelist rules record `created_by_org_id` (the creator's real
     org); a row the parent added to the org can only be removed by the parent (`403`).
   - IP whitelist: while the parent has rules covering a scope (`X` or `ALL`; any scope for an `ALL` rule)
     the org can't add its own rules for it (`403`; adding a rule would widen the allow-list).
   - SMPP accounts: created / updated by the parent → `locked_by_parent: true` (new response field). The
     org may then only tighten it (disable, lower `max_binds`/`max_tps`, fewer bind types; else `403`
     with `details.fields`) and can't delete it.
   The web shows these as API errors; no web change is required.
6. **Webhook SSRF guard** (api and engine, env `WEBHOOK_ALLOW_PRIVATE_TARGETS`, default off = guard on):
   webhook URLs must resolve only to public unicast addresses (loopback, RFC 1918, CGNAT, link-local,
   unique-local, multicast, reserved, documentation, and IPv4 embedded in mapped/NAT64/6to4 IPv6 are
   refused), no credentials in the URL. Checked on create/update (`400`, `details.field: "url"`) and
   again on the address actually connected to (api test sender: custom DNS lookup; engine
   `webhook.Options.BlockPrivate`: `net.Dialer.Control`), which defeats DNS rebinding. The engine's guarded
   client uses no HTTP proxy. **`POST /api/webhooks/:id/test` no longer relays the target's answer:
   `response_body` is always `null`** (status code and a coarse error only). Set
   `WEBHOOK_ALLOW_PRIVATE_TARGETS=1` for dev/test receivers on localhost (deploy/e2e/stack.sh,
   engine e2e and api tests do).
7. **Idempotent submits (internal API addition, CONTRACTS §5):** `POST /internal/v1/submit` and batch
   items accept an optional `"message_id": "<UUIDv7>"` (other UUIDs → `400`). The engine uses it as the
   message id; a repeat of an id an earlier attempt queued returns the original acceptance (same
   `message_id`, cost, parts) without debiting, storing, rate-limiting or queuing again. A repeat whose
   first attempt was debited but not queued: refunded → `500 INTERNAL`; still in flight → `409 CONFLICT`
   (retry later with the same id). Without `message_id` nothing changes. Old engines ignore the field.
8. **Campaigns**: every recipient is submitted with an api-chosen `message_id`, stored in
   `campaign_recipients.attempt_message_id` before the engine call and committed also when the call times
   out / fails with 5xx; the retry reuses it, so the engine never charges or sends a recipient twice.
   An engine timeout is treated as "outcome unknown", not "nothing recorded". `CONFLICT` results are
   retried. Pacing uses `campaigns.last_chunk_at` (clock time at the END of the chunk), so a chunk that
   takes > 1 s is no longer followed immediately by the next one.
9. **`Idempotency-Key` header** on `POST /v1/sms/send` and `POST /api/messages/send` (1-255 visible ASCII
   chars, kept 24 h per org in Redis `idem:send:<org_id>:<sha256(key)>`): a repeat returns the original
   result and never sends or charges twice; the same key with a different request → `409 CONFLICT`.
   An engine timeout / 5xx now returns `502 INTERNAL` with `details: {outcome: "unknown", retry_safe}`.
10. **`GET /v1/sms/:id`**: `cost_micros` is `0` when the message was fully refunded, plus a new
    `refunded: boolean` (partial refunds were already reflected in `client_cost_micros`).
11. **`GET /api/analytics/timeseries`** adds `day_boundary_shift_minutes`: daily buckets come from whole-UTC-hour
    rollups, so in a zone with a non-whole-hour offset (Asia/Kolkata → 30, Asia/Kathmandu → 45) up to that many
    minutes of traffic per day are counted on the previous date. `0` = exact. Documented approximation;
    exact local-day figures come from the message log / export.
12. **Whitelabel**: `GET /api/auth/me` adds top-level `brand_name` (own `brand_name`, else the client's
    reseller's; web part 1 #1). New public `GET /api/branding?host=<host>` (default: the request's Host):
    `{host, brand_name, reseller}` for an ACTIVE reseller whose `whitelabel_domain` matches
    (case-insensitive, port ignored; `brand_name` falls back to the reseller's name), else `brand_name: null`.
13. **Display fields**: `GET /api/audit-logs` items add `actor_email`, `impersonator_email`, `actor_org_name`,
    `target_org_name` (privileged lookup limited to ids on rows the caller can see). `GET /api/templates`
    items add `org_name` (null for route-wide templates).
14. **api tests** honour `TEST_DB_NAME` / `TEST_REDIS_DB` (defaults `sms_api2` / `5`).

## engine fixer: review findings (SMPP, dispatch, DLR, billing)

All backward compatible for the api and web; behaviour changes are listed so other components and
operators know them.

1. **Submit outcomes (CONTRACTS §8/§9 dispatcher).** Failover (and, after it, FAILED + refund) now
   happens only when a submit_sm was definitely not accepted: an error `command_status` /
   `generic_nack`, or nothing was written (no bound session, shutdown before the write).
   - `ESME_RTHROTTLED` / `ESME_RMSGQFUL`: the same PDU is resubmitted on the same connection with
     backoff (200 ms doubling to 5 s, for up to 60 s), and the connection's rate is halved for a
     cool-down. Only after that does it count as a rejection.
   - Unknown outcome (`submit_sm_resp` timeout, session lost after the write, shutdown mid-wait):
     the message is **not resent and not refunded**. The part is recorded as `UNKNOWN`, so a
     single-part message ends `UNKNOWN` with `error_code` `SUBMIT_TIMEOUT` / `SUBMIT_UNKNOWN` (the CDR
     carries the connection; no receipt can match it).
   - `msg:<id>` gets `submitting_ms` (+ `connection_id`, `pdus`) before the first PDU is written. A
     reclaimed entry with that marker but no `submitted_ms` (crashed instance) is finalized as
     `UNKNOWN` (`SUBMIT_INTERRUPTED`) instead of being sent again.
2. **dlrmap (§7).** Each part's entry is written as soon as its `submit_sm_resp` arrives (and again
   after the last part). Parts that got the same SMSC id share one entry. The value's part field may
   be a comma list: `<message_id>|<p1>,<p2>,...|<created_ms>`. One part keeps the old format exactly.
   `msg:<id>.pdus` is set before sending.
3. **Receipt matching.** The exact id is preferred. The lookup waits only for the connection's
   known id form; hex/decimal variants are tried once at the end and the converted form is learned
   per connection. The `message_logs` fallback orders exact-id rows first. A receipt that matches
   nothing is answered `ESME_RX_T_APPN` up to 3 times per id (counter `dlrunm:<conn>:<id>`, 1 h),
   then `ESME_ROK`.
4. **Final-status recording is replay-safe.** `msg:<id>` gets `fin_tok`, `fin_at`, `fin_e` and
   `emitted`. A go-redis retry of the record script, or a redelivered receipt after a failed
   finalize, re-emits the final status instead of losing it.
5. **`done_at`** (webhook §9 and the forwarded SMPP receipt's `done date`) is the engine's receive
   time, the same instant as `dlr_received_at`. It is no longer the upstream SMSC's local,
   zone-less `done date`.
6. **Parts (§3).** Parts = the number of segments actually sent (`len(coding.Split)`), not
   `ceil(units/153|67)`. They differ by +1 when an escape or surrogate pair straddles a segment
   boundary. Billing, MaxParts (`MESSAGE_TOO_LONG` above 10 segments), the CDR, template preview
   and the dispatcher all use it.
7. **Text validation:** text containing U+0000 is rejected with `INVALID_REQUEST`, as are source or
   client_ref values containing NUL or invalid UTF-8. The CDR writer also strips NUL, replaces invalid
   UTF-8, and truncates `varchar(n)` fields by characters, so a row is never dropped.
8. **Billing.**
   - A debit that fails with a transport error is refunded immediately (`refund.lua` answers
     `NO_TXN` if it never ran).
   - `refunded=true` is written only when the refund was applied. A refund that fails is queued in
     Redis list `refund:pending` (in memory if Redis is down) and retried every 10 s by every engine
     (per-message lock `refund:lock:<msg>`). When it succeeds, the CDR is updated (refunded flag or
     reduced partial-refund costs).
   - An enqueue error after MULTI/EXEC actually ran is detected (`msg:<id>.created_at_ms` exists) and
     the message is kept. A message that really was not queued is marked `done` before the refund, so
     a late stream entry is never dispatched.
   - `RefundUnloaded` (refund.lua `NOT_LOADED`) follows the lock-then-credit protocol: it locks
     `accounts_balance` FOR UPDATE, retries refund.lua under the lock, credits still-missing legs in
     the ledger and loaded legs via credit.lua, and advances the txn's refunded counters. The ledger
     idempotency key is `refund:<msg>:<org>`, with `:<refunded_before>` appended when non-zero.
   - Rate-limit checks pass the message id as a token (`rl:once:<id>`, 60 s), so a retried check
     never counts twice and returns `Replayed`.
9. **Credit limit / billing mode (§6).** After every config reload the engine pushes changed
   `billing_mode` / `credit_limit_micros` into loaded Redis balances (`limit` field). On startup it
   pushes all of them. `GET /internal/v1/balance` therefore reports the new limit about 0.2–1 s after
   `cfg:invalidate accounts_balance`.
10. **Upstream connection edits.** Changing `max_tps` applies in place, as do `name`,
    `request_dlr`, `multipart_mode` and `default_data_coding`, which are read per message. None of
    them rebinds the sessions any more. Host, port, TLS, credentials, system_type, bind_type,
    sessions, window, timers and enabled still rebind.
11. **Upstream sessions.**
    - The reconnect backoff resets only after a session stayed bound for 30 s. Before, an SMSC that
      drops sessions right after the bind was redialled about once a second.
    - While 64 receipt handlers are busy, further `deliver_sm` get `ESME_RX_T_APPN` instead of
      stalling the socket, so `submit_sm_resp` and keepalives keep being read.
12. **Client SMPP server (§4).**
    - `bind_resp` carries `sc_interface_version` only for `interface_version >= 0x34`.
    - Brute-force protection:
      - The IP whitelist is checked before the password, and gives `ESME_RBINDFAIL` without revealing
        whether the password was right.
      - A remote IP gets 20 failed binds and a system_id 30 per 5 minutes before further attempts get
        `ESME_RBINDFAIL` without an argon2 check. Credentials verified in the last 10 minutes still
        bind.
      - A connection is closed after 3 failed binds.
    - Unsupported content is rejected rather than re-encoded as text: `data_coding` 2/4 or ≥ 0x10
      (binary, message class/flash, compressed, MWI) → `ESME_RINVDCS` (0x104, SMPP v5.0 value);
      UDH elements other than concatenation (port addressing, etc.) → `ESME_RINVESMCLASS`.
    - When a multipart message is rejected on its completing part (e.g. `ESME_RTHROTTLED`), the
      acknowledged parts are kept, so the ESME's retry of that part completes it, under a fresh
      message id.
    - On an inbound unbind, running submit handlers finish and send their `submit_sm_resp` (≤ 5 s)
      before `unbind_resp`. Requests after the unbind get `ESME_RINVBNDSTS`.
13. **Multi-instance.**
    - Client multipart sets live in Redis (`cc:<system_id>:<hash>`, TTL = concat timeout), so parts
      sent on binds held by different instances join. Expired sets just expire, without the
      in-process `OnIncomplete` callback, and the per-system pending limit applies only in-process.
    - SMPP receipts are delivered only to sessions of the message's organization. A receipt for a
      system_id that was deleted, or now belongs to another org, is dropped.
    - Each instance advertises its RX/TRX receivers in `smpp:rx:<system_id>` (hash instance →
      `org|valid_until_ms`). A receipt read by an instance without the session is handed to
      `q:dlr-out:i:<instance>` of the one that holds it, with webhooks not re-enqueued.
    - Instance heartbeats are kept in `q:dlr-out:instances`. Streams of instances silent for more than
      2 minutes are moved back to `q:dlr-out`.
    - Pending receipts for offline clients are retried by a separate reclaim loop (≤ 1000 per pass),
      so they never delay new receipts.
    - `ENGINE_INSTANCE_ID` must be unique per running instance, as before.
14. **SMPP account passwords: not changed here.** The api still allows 1-character SMPP passwords
    (`smpp-accounts.controller.ts` `min(1)`; its tests rely on short ones). The engine-side limits in
    #12 bound guessing, but a minimum length (6–8) should be set by the api owner.

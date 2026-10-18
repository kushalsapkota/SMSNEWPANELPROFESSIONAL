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

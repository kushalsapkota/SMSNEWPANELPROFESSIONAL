# Nepal SMS providers: HTTP adapter specs

Researched 2026-10-18. Machine-readable version: [`nepal-adapters.json`](./nepal-adapters.json).

Confidence levels:

- **VERIFIED**: the official docs were fetched. Where noted, the endpoint was also probed live with a dummy token to confirm the error format.
- **LIKELY**: from client libraries or partial vendor pages.
- **UNKNOWN**: no usable public spec.

## Ranking by market relevance

| # | Provider | Relevance | Public API spec | Confidence | DLR | Balance API |
|---|---|---|---|---|---|---|
| 1 | **Sparrow SMS** | The market leader since 2010, with direct NTC/Ncell links. Every Nepali SMS list puts it first. | Yes (v2) | VERIFIED + live probe | none (dashboard only) | yes |
| 2 | **Aakash SMS** | The #2 incumbent (Aakash Tech). Very common in SME and school apps. | Yes (v3 form, v4 JSON) | VERIFIED + live probe | poll (paged report list) | yes |
| 3 | **Swift Technology SmartSMS** | A large aggregator in banking/BFIs and an NTC/Ncell partner. | No (vendor-shared only) | LIKELY (3rd-party lib) | unknown | unknown |
| 4 | **MessengerNepal** | A newer Kathmandu company with modern API, OpenAPI and webhooks. | Yes (OpenAPI 3) | VERIFIED | callback (HMAC) | in send response only |
| 5 | **Twozero SMS** | A newer reseller that fails over across gateways. | Yes | VERIFIED | poll | yes |
| 6 | **Nest SMS** | A newer Lalitpur company that looks like the same white-label platform as MessengerNepal. | Yes, but host is a placeholder | LIKELY | poll | yes |
| 7 | **Bullet SMS** (Zwicky Technology) | New and small. | Landing-page sample only | LIKELY | callback (claimed) | unknown |
| 8 | **Bitmoro** | Small. | npm SDK only. The endpoint returned 404 when probed. | LIKELY (possibly stale) | callback per request | unknown |

These providers were checked and have **no usable public HTTP API spec**:

| Provider | Finding |
|---|---|
| Nepal Telecom bulk SMS | Partner/SMPP agreements only, with no public HTTP spec. |
| Ncell bulk SMS | Partner-only developer access, with no public HTTP spec. |
| SMS Pasal (smspasal.com) | Advertises a REST API, but keys and docs are only available after login. |
| Webbank Nepal | Describes an API but publishes no endpoints. |
| Bulk SMS Nepal (bulksmsnepal.com) | The site was down (HTTP 522). |
| Samaya Technology, Nitya SMS, Classic Tech SMS, Chhito Connect, Creation Soft, The SMS Central, Hamro SMS, Kaicho, Sociair, Broadway, "Fast SMS Nepal", Notifyy | No public API documentation found. |
| NepalOTP | OTP-only, template-based (`/v1/otp/send`). It is not a generic MT route. |

The `rupeshdahal/nepali-sms-gateway` "FastSms" driver points at `fastsms.com/api/v1`. It looks invented: its Aakash URL in the same package is also wrong. **Do not use it.**

International aggregators that cover Nepal (SMS.to, EasySendSMS, Twilio and others) have their own global APIs and are out of scope here.

---

## 1. Sparrow SMS (VERIFIED)

- Docs:
  - https://docs.sparrowsms.com/sms/outgoing_sendsms/
  - https://docs.sparrowsms.com/sms/outgoing_credits/
  - Source markdown: https://github.com/sparrowsms/apidocs/tree/master/docs/sms
- Last updated: the docs say 2020-03-13, but the API is live.
- Live probe on 2026-10-18: `https://api.sparrowsms.com/v2/sms/` and `/v2/credit/` both return JSON errors. HTTPS works even though the docs show `http://`.

### Send

| | |
|---|---|
| URL | `https://api.sparrowsms.com/v2/sms/` (trailing slash) |
| Method | `GET` (query) or `POST` (form; the official curl uses `-F`) |
| Auth | `token` param (generated in the dashboard) |
| Recipients | `to`: comma-separated **10-digit** numbers (`98XXXXXXXX`) |
| Text | `text` |
| Sender | `from`: the identity assigned to the account (NTA-approved sender ID). It is required. |
| Unicode | Automatic, with no flag. Sparrow FAQ: Nepali Unicode is 70 chars for 1 credit, then 67 chars per extra credit. |
| Scheduling | none |
| Optional fields | none documented |

Success (HTTP 200):

```json
{"count": 2, "response_code": 200, "response": "2 mesages has been queued for delivery"}
```

Errors (HTTP 403). The body is `{"response_code": <code>, "response": "<msg>"}`, and live responses also include `"requested_ip": "x.x.x.x"`:

| code | meaning |
|---|---|
| 1000 | A required field is missing |
| 1001 | Invalid IP Address (the account is IP-whitelisted, so register the gateway's egress IPs) |
| 1002 | Invalid Token |
| 1003 / 1004 | Account Inactive |
| 1005 / 1006 | Account has been expired |
| 1007 | Invalid Receiver |
| 1008 | Invalid Sender |
| 1010 | Text cannot be empty |
| 1011 | No valid receiver |
| 1012 | No Credits Available |
| 1013 | Insufficient Credits |

**Message ID:** none is returned. You only get `count`.

**DLR:** none in the v2 public API. There is no callback and no status endpoint, so status is visible in the dashboard only. The Enterprise suite (`ent-api.sparrowsms.com`) uses a JWT bearer obtained via `POST /v1/autho/apitoken/login/` with `api_token` and `partner_token`. Its batch reports cover Viber and international SMS only.

**Balance:** `GET https://api.sparrowsms.com/v2/credit/?token=...` returns `{"credits_available": N, "credits_consumed": N, "response_code": 200}`. Errors use the same 403 envelope (1001–1006, 1012).

**MO (incoming):** Sparrow sends a GET to your URL with `from`, `to` (shortcode), `text` and `keyword`. Reply with text of up to 160 chars and HTTP 200 or 202.

**Rate limits:** none documented.

## 2. Aakash SMS (VERIFIED)

- Docs:
  - https://aakashsms.com/documentation/ (blocks non-browser user agents with HTTP 406)
  - Full spec: https://bitbucket.org/aakashsms/api/src/v4 (README.md)
- Live probe on 2026-10-18:
  - v3 send with a bad token returned **HTTP 200** with `{"error":true,"message":"The provided Auth Token is not valid.","data":[]}`.
  - v4 credit with a bad token returned **HTTP 401** with `{"error":true,"message":"Authentication token is invalid or expired","response_code":401,"data":[]}`.

### Send (v3, current and simplest)

| | |
|---|---|
| URL | `https://sms.aakashsms.com/sms/v3/send` (the examples also use `/send/`) |
| Method | `POST` (form) or `GET` |
| Auth | `auth_token` param. The official curl sample wrongly says `token`, but every other sample and the field table say `auth_token`. |
| Recipients | `to`: comma-separated 10-digit numbers |
| Text | `text` |
| Sender | **No parameter.** The sender is fixed per account. |
| Unicode / scheduling | Not documented, and there is no flag. |

Success. **You must check `error === false`, because HTTP is 200 on errors too.**

```json
{"error": false, "message": "1 messages has been queued for delivery.",
 "data": {"valid":   [{"id": 2673160, "mobile": "9779818000000", "text": "v3 sms test", "credit": 1, "network": "ncell", "status": "queued"}],
          "invalid": [{"mobile": "988585584", "text": "v3 sms test", "credit": 0, "network": "N/A", "status": "aborted"}]}}
```

Partial success is possible: map `data.valid[].id` to the provider message id per recipient, and treat `data.invalid[]` as per-recipient rejections.

Errors (`data: []`). There are no numeric codes, only message strings:

- `The provided Auth Token is not valid.`
- `The auth token field is required.`
- `The to field is required.`
- `The text field is required.`
- `Not enough balance.`

### Send (v4, JSON with per-recipient texts)

- Request: `POST https://sms.aakashsms.com/sms/v4/send-user` with header `auth-token: <token>` and body `{"to": ["98XXXXXXXX", ...], "text": ["msg"]}`.
  - One text means the same message goes to everyone.
  - N texts map to N numbers, in order.
- Success: `{"responses":[{"error":false,"message":"...","data":{"valid":[{"id":"8967_173191065276114","mobile":"977...","text":"...","credit":1,"network":"ntc","status":"queued","shortcode":"..."}],"invalid":[]}}],"errors":[]}`. In v4 the id is a **string**.
- Failure: `{"error":true,"message":"All messages encountered errors.","errors":[{"error":true,"message":"No valid recipients."|"Not enough balance.", ...}]}`.

### DLR

There is no webhook for MT. Poll the paged report list instead:

- **v1:** `POST https://sms.aakashsms.com/sms/v1/report/api` (form: `auth_token`, `page` starting at 1).
  - Response: `{"error":false,"total_page":1,"response_code":"201","data":[{"id":1968977,"receiver":"984*******","network":"ntc","message":"...","api_credit":"1","delivery_at":"2019-05-30 16:35:01"}]}`.
  - There is no explicit status field. `delivery_at` is the only delivery signal. Numbers are masked, so match on `id`.
- **v4:** `POST https://sms.aakashsms.com/sms/v4/api-report` with header `auth-token` and body `start_date` and `end_date` (`Y-m-d`). The response is undocumented.

### Balance

| Endpoint | Auth | Response |
|---|---|---|
| `POST https://sms.aakashsms.com/sms/v1/credit` | form `auth_token` | `{"available_credit":N,"total_sms_sent":N,"response_code":202}` |
| `GET https://sms.aakashsms.com/sms/v4/available-credit` | header `auth-token` | `{"available_credit":N,"response_code":200}` |
| `POST https://sms.aakashsms.com/sms/v4/credit` | header `auth-token` | adds `last_transaction_date` and `last_transaction_date_sms_sent` |

### Other

- **MO:** Aakash sends a GET to your URL with `keyword`, `from` and `text`.
- **Interactive SMS:** `POST /sms/v1/send/interactive-sms` with `campaign_id`.
- **Rate limits:** none documented.

## 3. Swift Technology SmartSMS (LIKELY)

- Sources:
  - The `rayzenai/laravel-sms` v7.0.0 library, `src/Providers/SwiftSmsProvider.php` (https://github.com/rayzenai/laravel-sms)
  - Vendor page: https://swifttech.com.np/enterprise-messaging/
- No public docs exist. Ask Swift for the official spec.

### Send

| | |
|---|---|
| Single send | `POST https://smartsms.swifttech.com.np:8083/api/Sms/ExecuteSendSmsV5` (JSON) |
| Auth | HTTP **Basic** (username:password) plus header `OrganisationCode: <code>` |
| Body | `{"Message": text, "ReceiverNo": number, "IsClientLogin": "N", "Date": "yyyy/MM/dd HH:mm:ss"}` |
| Success | `responseCode == 100`. The message id is `messageId` and the error text is `responseDescription`. |
| Bulk send | `POST .../SaveBulkSMSV5` with `{"SmsDetails":[{"Message","ReceiverNo"}...], "BatchId": "<client id>", "Date", "IsClientLogin":"N"}` |

**Unknowns:**

- The recipient number format. The library validator requires `+977XXXXXXXXXX`, but that is not confirmed as Swift's expectation.
- Other response codes.
- DLR and balance endpoints.
- Sender selection.
- Whether port 8083 is reachable from outside Nepal.

## 4. MessengerNepal (VERIFIED)

- Docs:
  - https://messengernepal.com.np/docs
  - OpenAPI: https://api.messengernepal.com.np/api/v1/sms/openapi.json
  - Webhooks: https://messengernepal.com.np/docs/webhooks

### Send

| | |
|---|---|
| URL | `POST https://api.messengernepal.com.np/api/v1/sms/send` (default sender), or `.../sms/send/with-sender-id` (`sender_id` required) |
| Auth | Header `X-API-Key: msnp_live_...` (`msnp_test_...` for sandbox). An optional `Idempotency-Key` header is supported. |
| Recipients | `to`: a string, a CSV string or an array (max 1000), as local 10-digit or `977`-prefixed numbers |
| Text | `message`. Max 720 GSM-7 septets or 335 UCS-2 chars. `type` = `text`, `unicode` or `flash`, auto-detected: one Nepali char makes the whole body UCS-2. |
| Other fields | `message_type` = `promotional`, `transactional` or `otp`; `template_id` or `template_name` plus `variables` |

Success is **HTTP 202**:

- Single recipient: `{"success":true,"message":"SMS accepted for delivery","data":{"dispatch_id":"661f…","job_id":"661f…","message_id":"661f…","status":"accepted","environment":"live","recipient":"9800000000","cost":1,"remaining_balance":482,"remaining_credits":482}}`
- Several recipients: `data.batch_id`, `total_count`, `accepted_count`, `total_cost` and `dispatch_ids[]`.

Errors: `{"success":false,"error":"Insufficient credits","code":"INSUFFICIENT_CREDITS"}`.

- Codes include `VALIDATION_ERROR` and `RATE_LIMIT_EXCEEDED`. A 429 also carries a `Retry-After` header and a `retry_after` field.
- HTTP statuses: 400, 401, 403, 429, 503.

### DLR

Signed **webhooks**, configured in the dashboard rather than per request.

- Events: `sms.accepted`, `sms.sending`, `sms.sent`, `sms.delivered`, `sms.failed`, `sms.unknown`, `sms.cancelled`.
- Body: `{id, type, created_at, data:{message_id, dispatch_id, batch_id, status, channel:"sms", recipient:"97798…", sent_at, delivered_at, failed_at, error_code, error_message, cost, environment}}`.
- Signature: `X-Msngr-Signature: sha256=<hex HMAC-SHA256(secret, "{X-Msngr-Timestamp}.{rawBody}")>`. Further headers are `X-Msngr-Event` and `X-Msngr-Delivery-Id`.
- There is no public SMS status poll.

### Balance

There is no balance endpoint. Use `remaining_credits` from the send response. `GET /api/v1/sms/sender-ids` lists approved senders.

**Account requirements:** live keys need KYC and live-API approval.

## 5. Twozero SMS (VERIFIED)

- Docs: https://sms.twozero.io/api-docs
- Twozero is a reseller: the docs say bulk "fails over between gateways".

### Send

| | |
|---|---|
| URL | `POST https://sms.twozero.io/api/v1/sms/send` (JSON) |
| Auth | Header `X-API-Key: sk_...`, plus an optional `Idempotency-Key` |
| Body | `{"to": "9841234567", "message": "...", "sender_id": "TZLABS"}` |
| `to` | `+977…`, `977…` or 10 digits |
| `message` | up to 1600 chars |
| `sender_id` | 11 chars max |

- Success (HTTP 200): `{"status":"success","message":"SMS sent successfully","data":{"message_id":"msg_abc123def456","to":"9841234567","credits_used":1,"status":"sent"}}`
- Error example (HTTP 400): `{"status":"error","message":"Insufficient credits","data":null}`
- Other HTTP codes: 401, 403 (inactive account or IP not whitelisted), 404, 409 (idempotency conflict), 422, 429, 500.

### Bulk

- Request: `POST /api/v1/sms/send-bulk` with `{"recipients":[...≤1000], "message", "sender_id"}`.
- Response: HTTP 202 with `data.batch_id`. Poll progress at `GET /api/v1/sms/batches/{batch_id}`.

### DLR

- Poll: `GET /api/v1/sms/status/{message_id}` returns `data.status` as `pending`, `sent`, `delivered`, `failed` or `rejected`, plus `delivery_report{status,description,reported_at}`.
- No webhook is documented.

### Balance

`GET /api/v1/account/balance` returns `{"status":"success","data":{"credits":5000,"kyc_status":"approved","kyc_verified":true}}`.

### Rate limits

| Endpoint | Limit |
|---|---|
| send | 100 per minute |
| send-bulk | 10 per minute |
| status / history / balance | 300 per minute |

## 6. Nest SMS (LIKELY)

- Docs: https://nestsms.com/docs (Kupondole, Lalitpur).
- The API shape is the same as MessengerNepal (same white-label platform):
  - `POST /api/v1/sms/send` with header `X-API-Key: nsms_live_...` (Bearer is also accepted).
  - Body: `to` (string, array or CSV, ≤1000), `message` (720 text / 335 unicode), optional `sender_id`, `type`, `message_type`, `template_id` and `variables`.
- **The production host is not documented** (the docs show only `https://your-domain.com`). `nestsms.com/api/v1/...` returns 404. Ask the vendor.

| | |
|---|---|
| Success | `{"success":true,"message":"SMS queued successfully","data":{"job_id":"…","cost":1.0,"remaining_balance":499.0}}` |
| Errors | `{"success":false,"error":"…","code":"INSUFFICIENT_BALANCE"}` |
| DLR | Poll `GET /api/v1/sms/status/:messageId`. There is a documented ambiguity between `job_id` and `message_id`. |
| Balance | `GET /api/v1/sms/balance` |
| Rate limits | 60 per minute and 1000 per hour per key |

Error codes:

| HTTP | Codes |
|---|---|
| 401 | `NO_API_KEY`, `INVALID_API_KEY` |
| 403 | `ORG_INACTIVE`, `IP_RESTRICTED` |
| 400 | `MISSING_TO`, `INVALID_TO_FORMAT`, `MESSAGE_TOO_LONG`, `INSUFFICIENT_BALANCE` |
| 404 | `MESSAGE_NOT_FOUND` |
| 429 | `RATE_LIMIT_EXCEEDED` |

## 7. Bullet SMS (LIKELY)

- Page: https://bulletsms.com/developers

| | |
|---|---|
| Request | `POST https://bulletsms.com/api/v1/sms/send` with `Authorization: Bearer <token>`, optional `Idempotency-Key`, and body `{"to":["9801234567"],"message":"…","senderId":"BulletSMS"}` |
| Other endpoints (claimed) | `POST /api/v1/sms/send-dynamic`, `GET /api/v1/sms/reports`, `POST /api/v1/campaigns`, `DELETE /api/v1/campaigns/:id` |
| DLR | HMAC-signed webhooks are claimed |
| Unknown | Response body, errors, message id and balance API |

## 8. Bitmoro (LIKELY, possibly stale)

- Source: npm `bitmoro` v1.1.2 (published 2025-03).

| | |
|---|---|
| Bulk send | `POST https://api.bitmoro.com/message/api/bulk` with `Authorization: Bearer <token>` and JSON `{"number":["98…"],"message","senderId?","scheduledDate?" (unix ms),"callbackUrl?"}` |
| Bulk response | `{status:"QUEUED"\|"SCHEDULED", report:[{to,messageId,text,from,type(1 ASCII/2 Unicode),credit}], creditSpent, messageId, senderId}` |
| Single / OTP send | `POST /message/api/single-message`, which returns `{status:"DISPATCHED"\|"FAILED", messageId, statusUrl:"https://api.bitmoro.com/messages/{id}"}` |
| DLR | A POST to `callbackUrl`. The payload is undocumented. |

**Warning:** on 2026-10-18 a probe of `/message/api/bulk` returned HTTP 404 (an HTML page).

---

## Nepal SMS specifics for the gateway

### Number format

- Mobile numbers are 10 digits starting with `9`. E.164 is `+977` followed by the 10 digits, e.g. `+9779841234567`.
- **Every documented Nepali provider wants the local 10-digit form** (`98XXXXXXXX`) in requests. Some also accept `977…`.
- Normalise input by stripping `+`, spaces, dashes and a leading `977` (or `00977`). Then require `^9[678]\d{8}$`.
- Providers often echo numbers back as `977…`. Aakash masks them (`977981*******`).

### Operators and prefixes

Sources: nepalitelecom.com, sent.dm and Wikipedia.

| Operator | Prefixes | Status |
|---|---|---|
| Nepal Telecom (NTC / Namaste) | 984, 985, 986 (GSM); 974, 975 (ex-CDMA, now GSM); 976 | Active |
| Ncell | 980, 981, 982; 970, 971 also reported | Active |
| Smart Telecom (Smart Cell) | 961, 962, 988 | Licence revoked by NTA in 2023 and assets taken over (Kathmandu Post, 2023-04-17). Treat as **inactive**: providers mark these numbers invalid or aborted. |
| UTL | 972 (CDMA) | Defunct |
| Hello Mobile | 963 | Defunct |

- Practically, only **NTC and Ncell** are live in 2026. Recommended validation: `^9(8[0-2]|8[4-6]|7[0-1]|7[4-6])\d{7}$`, with an admin-toggleable allowance for 961/962/988.
- Mobile number portability is not operational, so the prefix reliably identifies the operator for routing and pricing.
- Aakash's response returns `network` (`ntc` or `ncell`), which can confirm the operator.

### Encoding and length

- GSM-7: 160 chars, or 153 per part when concatenated.
- Any Devanagari character forces UCS-2 for the whole message: 70 chars, or 67 per part. Sparrow and Aakash bill 70, then 67 per extra credit.
- No provider requires a unicode flag on the legacy APIs. MessengerNepal and NestSMS accept `type=unicode` but auto-detect it anyway.
- Send UTF-8 form or JSON bodies.

### Sender IDs

- Alphanumeric sender IDs must be pre-registered and approved (NTA, NTC and Ncell, via the aggregator). Registration takes several business days.
- Unregistered IDs are overwritten with a generic ID.
- Sparrow requires `from` to be one of the identities assigned to the account. Aakash has no sender parameter, so the sender is fixed per account.
- Short codes and long codes are not available for A2P.
- Keep the sender to 11 characters or fewer.

### Other notes

- **IP whitelisting:** Sparrow (error 1001) and Twozero (HTTP 403) can restrict by IP. Expose the gateway's static egress IPs to admins.
- **Quiet hours:** the recommended sending window is 08:00–20:00 NPT (UTC+05:45), with OTP and alerts exempt.
- **Opt-out:** honour STOP or its Nepali equivalent within 24 hours. There is no national DND registry.
- **Regulatory flux:** sent.dm reports that in July 2025 NTA told operators not to terminate unauthorized A2P SMS. Expect sender and route rules to tighten.

## Biggest open questions

1. **Sparrow DLR and message ids.** v2 returns neither. Does Sparrow offer a DLR callback or report API to enterprise customers? Ask Sparrow, or treat Sparrow routes as "submitted = final".
2. **Aakash DLR semantics.** The report API has no status field and masks numbers. Is `delivery_at` the submit time or the handset delivery time? Is there a webhook for MT DLR?
3. **Swift SmartSMS.** We have no official spec: the number format, codes other than 100, DLR and balance endpoints are all unknown, as is whether the `:8083` host is internet-reachable.
4. **Nest SMS production host** and the `job_id` vs `message_id` ambiguity.
5. **Bitmoro** may have changed its API, since the probe returned 404.
6. **Smart Telecom (961/962/988):** confirm whether any aggregator still accepts these numbers.
7. **Rate limits for Sparrow and Aakash** are undocumented. Start conservatively (for example 5–10 requests per second, batching up to roughly 100 numbers per request via the comma-separated `to`) until confirmed.

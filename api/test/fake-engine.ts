import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { FAKE_ADAPTERS } from './fake-adapters';

export interface FakeReject {
  status: number;
  error_code: string;
  message: string;
}

function isReject(r: FakeReject | Record<string, unknown>): r is FakeReject {
  return typeof (r as FakeReject).error_code === 'string';
}

/** UUIDv7 like the engine's message ids (time-ordered, ms timestamp in the first 48 bits). */
export function uuidV7(ms = Date.now()): string {
  const hex = ms.toString(16).padStart(12, '0') + randomUUID().replace(/-/g, '').slice(12);
  const h = hex.split('');
  h[12] = '7';
  h[16] = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

export interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
  token: string | undefined;
}

/**
 * Local fake of the engine internal HTTP API (CONTRACTS §5). Tests tweak `creditStatus`,
 * `balances`, `down` and inspect `requests`.
 */
export class FakeEngine {
  requests: RecordedRequest[] = [];
  creditStatus: 'OK' | 'DUPLICATE' | 'NOT_LOADED' = 'OK';
  /** Live Redis balances; GET /balance/:id returns 503 for orgs not present (forces DB fallback). */
  balances = new Map<string, number>();
  /** When true every request gets a 503 (engine down). */
  down = false;
  /** Per-destination rejections for /submit and /submit/batch (destination = normalized digits). */
  rejects = new Map<string, FakeReject>();
  /** When set, every submit is rejected with this. */
  rejectAll: FakeReject | null = null;
  /** cost per accepted message. */
  submitCost = 5000;
  /**
   * Accepted messages by id, like the engine's per-message-id debit: a submit repeating an
   * accepted `message_id` returns the original result and is not sent / charged again.
   */
  accepted = new Map<string, Record<string, unknown>>();
  /** Number of distinct messages sent (and charged) — repeats of an accepted id don't count. */
  sends = 0;
  /**
   * /submit/batch processes (accepts) only the first N items, then answers 503 — the engine
   * behaviour when the api's request is cut off mid-batch (timeout) or the engine fails.
   */
  batchFailAfter: number | null = null;
  /** Artificial latency for /submit/batch (ms). */
  batchDelayMs = 0;
  /** /submit accepts the message, then answers 503 (outcome unknown to the api). */
  submitFailAfterAccept = false;
  connections: unknown[] = [];
  /** HTTP adapter catalogue served at /internal/v1/adapters; `adaptersDown` → 503 for that path only. */
  adapters: unknown[] = FAKE_ADAPTERS;
  adaptersDown = false;
  /** Reply of POST /internal/v1/connections/:id/test (connection id substituted in `request`). */
  testReply: Record<string, unknown> = {
    ok: true,
    provider_message_id: 'prov-123',
    http_status: 200,
    request: { method: 'POST', url: 'https://sms.aakashsms.com/sms/v3/send', body: 'auth_token=****&to=9800000000&text=hi' },
    response_body: '{"error":false,"message":"1 messages has been queued"}',
    error: null,
    duration_ms: 42,
  };
  balanceReply: Record<string, unknown> = { supported: true, balance: '1234', raw: '{"available_credit":1234}', error: null };
  /** dlr tokens the engine knows (provider-dlr → 404 for others); null = accept every token. */
  dlrTokens: Set<string> | null = null;
  /** Prometheus counter value served at /metrics (smsgw_submit_total). */
  metricsSubmitTotal = 0;
  /** Telegram Bot API requests received at /bot<token>/sendMessage. */
  telegram: { token: string; body: any }[] = [];
  private server!: http.Server;
  url = '';

  constructor(private readonly token: string) {}

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const body = raw ? JSON.parse(raw) : undefined;
        const path = req.url ?? '/';
        this.requests.push({ method: req.method ?? 'GET', path, body, token: req.headers['x-internal-token'] as string | undefined });
        const send = (status: number, payload: unknown) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        const tg = /^\/bot([^/]+)\/sendMessage$/.exec(path);
        if (tg) {
          this.telegram.push({ token: tg[1], body });
          return send(200, { ok: true, result: { message_id: this.telegram.length } });
        }
        if (path === '/metrics') {
          res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
          res.end(
            `# HELP smsgw_submit_total x\n# TYPE smsgw_submit_total counter\n` +
              `smsgw_submit_total{channel="HTTP",result="accepted"} ${this.metricsSubmitTotal}\n` +
              `smsgw_submit_total{channel="SMPP",result="RATE_LIMITED"} 0\nsmsgw_submit_total_other 999\n`,
          );
          return;
        }
        if (req.headers['x-internal-token'] !== this.token) return send(401, { error_code: 'UNAUTHORIZED', message: 'bad token' });
        if (this.down) return send(503, { error_code: 'INTERNAL', message: 'down' });
        this.route(req.method ?? 'GET', path, body, send);
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  private route(method: string, path: string, body: any, send: (s: number, p: unknown) => void): void {
    if (method === 'POST' && path === '/internal/v1/balance/credit') {
      if (this.creditStatus === 'NOT_LOADED') return send(200, { status: 'NOT_LOADED', balance_micros: null });
      const cur = (this.balances.get(body.org_id) ?? 0) + (this.creditStatus === 'OK' ? body.delta_micros : 0);
      this.balances.set(body.org_id, cur);
      return send(200, { status: this.creditStatus, balance_micros: cur });
    }
    const bal = /^\/internal\/v1\/balance\/([0-9a-f-]+)$/.exec(path);
    if (method === 'GET' && bal) {
      if (!this.balances.has(bal[1])) return send(503, { error_code: 'INTERNAL', message: 'not available' });
      return send(200, { balance_micros: this.balances.get(bal[1]), credit_limit_micros: 0, loaded: true });
    }
    if (method === 'POST' && path === '/internal/v1/submit') {
      const r = this.submitOne(body);
      if (this.submitFailAfterAccept) return send(503, { error_code: 'INTERNAL', message: 'timed out after accepting' });
      return isReject(r) ? send(r.status, { error_code: r.error_code, message: r.message }) : send(200, r);
    }
    if (method === 'POST' && path === '/internal/v1/submit/batch') {
      const items = body.items as any[];
      const n = this.batchFailAfter ?? items.length;
      const results = items.slice(0, n).map((item) => {
        const r = this.submitOne(item);
        return isReject(r) ? { error_code: r.error_code, message: r.message } : r;
      });
      const reply = () => (this.batchFailAfter !== null ? send(503, { error_code: 'INTERNAL', message: 'cut off mid-batch' }) : send(200, { results }));
      if (this.batchDelayMs > 0) setTimeout(reply, this.batchDelayMs);
      else reply();
      return;
    }
    if (method === 'POST' && path === '/internal/v1/smpp/sessions/kick') return send(200, { kicked: 1 });
    if (method === 'POST' && path === '/internal/v1/config/reload') return send(200, { version: this.calls(path).length });
    if (method === 'GET' && path === '/internal/v1/smpp/sessions') {
      return send(200, { sessions: this.sessions });
    }
    if (method === 'GET' && path === '/internal/v1/connections/status') return send(200, { connections: this.connections });
    if (method === 'GET' && path === '/internal/v1/adapters') {
      if (this.adaptersDown) return send(503, { error_code: 'INTERNAL', message: 'down' });
      return send(200, { adapters: this.adapters });
    }
    const ct = /^\/internal\/v1\/connections\/([0-9a-f-]+)\/(test|balance)$/.exec(path);
    if (ct && method === 'POST' && ct[2] === 'test') return send(200, this.testReply);
    if (ct && method === 'GET' && ct[2] === 'balance') return send(200, this.balanceReply);
    const pd = /^\/internal\/v1\/provider-dlr\/([^/?]+)$/.exec(path);
    if (pd && method === 'POST') {
      if (this.dlrTokens && !this.dlrTokens.has(decodeURIComponent(pd[1]))) return send(404, { error_code: 'NOT_FOUND', message: 'unknown token' });
      return send(200, { accepted: 1 });
    }
    if (method === 'GET' && path === '/internal/v1/health') return send(200, { ok: true, db: true, redis: true });
    if (method === 'POST' && path === '/internal/v1/template/preview') {
      const m = /\b[0-9]{4,8}\b/.exec(body.text ?? '');
      const tpl = body.template?.template_body ?? 'Your code is {otp}';
      return send(200, {
        otp: m ? m[0] : null,
        matched_pattern: m ? '\\b[0-9]{4,8}\\b' : null,
        action: m ? 'TEMPLATED' : 'SEND_RAW',
        output: m ? tpl.replace('{otp}', m[0]) : body.text,
        encoding: 'GSM7',
        parts: 1,
        template_id: null,
      });
    }
    send(404, { error_code: 'NOT_FOUND', message: `no fake for ${method} ${path}` });
  }

  private submitOne(item: any): FakeReject | Record<string, unknown> {
    if (typeof item.message_id === 'string' && this.accepted.has(item.message_id)) return this.accepted.get(item.message_id)!;
    const rej = this.rejectAll ?? this.rejects.get(item.destination);
    if (rej) return rej;
    this.sends += 1;
    const res = {
      message_id: typeof item.message_id === 'string' ? item.message_id : uuidV7(),
      status: 'ACCEPTED',
      parts: 1,
      encoding: 'GSM7',
      cost_micros: this.submitCost,
      route_id: item.route_id ?? '00000000-0000-4000-8000-000000000001',
      sent_text: item.text,
    };
    this.accepted.set(res.message_id, res);
    return res;
  }

  sessions: { session_id: string; org_id: string; system_id: string; bind_type: string; remote_addr: string; bound_since: string; tps_current: number; submitted_total: number }[] = [];

  calls(path: string): RecordedRequest[] {
    return this.requests.filter((r) => r.path === path);
  }

  reset(): void {
    this.requests = [];
    this.creditStatus = 'OK';
    this.down = false;
    this.rejects.clear();
    this.rejectAll = null;
    this.submitCost = 5000;
    this.accepted.clear();
    this.sends = 0;
    this.batchFailAfter = null;
    this.batchDelayMs = 0;
    this.submitFailAfterAccept = false;
    this.connections = [];
    this.telegram = [];
    this.adapters = FAKE_ADAPTERS;
    this.adaptersDown = false;
    this.dlrTokens = null;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

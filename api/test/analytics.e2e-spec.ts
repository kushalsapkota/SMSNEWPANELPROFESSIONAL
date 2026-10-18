import { randomUUID } from 'node:crypto';
import { Session, TestCtx, adminLogin, as, createChild, insertMessage, setup, uniq } from './helpers';

const H = 3_600_000;
const D = 24 * H;

/**
 * Role-correct analytics math from seeded message_stats_hourly rows:
 *   admin    revenue = reseller_cost, cost = route_cost
 *   reseller revenue = clients' client_cost, cost = reseller_cost
 *   client   spend = client_cost (revenue/profit 0)
 */
describe('analytics, dashboard, tester', () => {
  let ctx: TestCtx;
  let admin: Session;
  let rA: Session;
  let cA1: Session;
  let cA2: Session;
  let rB: Session;
  let cB: Session;
  const R1 = randomUUID();
  const R2 = randomUUID();
  const today0 = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').getTime();
  const h1 = new Date(today0 - 4 * H); // 20:00Z yesterday = 01:30 today in Asia/Kolkata
  const h2 = new Date(today0 - 30 * H);
  const h3 = new Date(today0 + 1 * H);
  const range = `from=${new Date(today0 - 3 * D).toISOString()}&to=${new Date(today0 + D).toISOString()}`;

  beforeAll(async () => {
    ctx = await setup({ env: (url) => ({ ENGINE_METRICS_URL: `${url}/metrics` }) });
    admin = await adminLogin(ctx);
    rA = await createChild(ctx, admin, uniq('an-rA'));
    rB = await createChild(ctx, admin, uniq('an-rB'));
    cA1 = await createChild(ctx, rA, uniq('an-cA1'));
    cA2 = await createChild(ctx, rA, uniq('an-cA2'));
    cB = await createChild(ctx, rB, uniq('an-cB'));
    await ctx.db.insertInto('routes').values([{ id: R1, name: uniq('Route-One') }, { id: R2, name: uniq('Route-Two') }]).execute();

    const row = (bucket: Date, org: string, reseller: string, route: string, country: string, v: Partial<Record<string, number>>) => ({
      bucket,
      org_id: org,
      reseller_id: reseller,
      route_id: route,
      country_iso: country,
      messages: 0,
      parts: 0,
      submitted: 0,
      delivered: 0,
      undelivered: 0,
      failed: 0,
      rejected: 0,
      expired: 0,
      client_cost_micros: 0,
      reseller_cost_micros: 0,
      route_cost_micros: 0,
      ...v,
    });
    await ctx.db
      .insertInto('message_stats_hourly')
      .values([
        row(h1, cA1.orgId, rA.orgId, R1, 'IN', { messages: 10, parts: 12, submitted: 10, delivered: 7, undelivered: 1, failed: 1, client_cost_micros: 1200, reseller_cost_micros: 800, route_cost_micros: 300 }),
        row(h2, cA1.orgId, rA.orgId, R2, 'GB', { messages: 5, parts: 5, submitted: 5, delivered: 5, client_cost_micros: 500, reseller_cost_micros: 400, route_cost_micros: 200 }),
        row(h1, cA2.orgId, rA.orgId, R1, 'IN', { messages: 4, parts: 4, submitted: 4, delivered: 2, failed: 2, client_cost_micros: 400, reseller_cost_micros: 300, route_cost_micros: 100 }),
        // reseller's own sends: no client revenue for the reseller, its reseller_cost is still a cost
        row(h3, rA.orgId, rA.orgId, R1, 'IN', { messages: 2, parts: 2, submitted: 2, delivered: 2, client_cost_micros: 160, reseller_cost_micros: 160, route_cost_micros: 50 }),
        row(h1, cB.orgId, rB.orgId, R2, 'US', { messages: 8, parts: 8, submitted: 8, delivered: 8, client_cost_micros: 1000, reseller_cost_micros: 700, route_cost_micros: 350 }),
        // outside the default 7-day window
        row(new Date(today0 - 30 * D), cA1.orgId, rA.orgId, R1, 'IN', { messages: 100, parts: 100, delivered: 100, client_cost_micros: 9999 }),
      ])
      .execute();
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(() => ctx.engine.reset());

  describe('summary', () => {
    it('admin: revenue = reseller_cost, cost = route_cost', async () => {
      const all = (await as(ctx, admin).get(`/api/analytics/summary?${range}`)).body;
      // other suites' rows never land in this DB/time range, but be robust: compare this file's orgs only
      expect(all.messages).toBeGreaterThanOrEqual(29);
      const tree = (await as(ctx, admin).get(`/api/analytics/summary?${range}&org_id=${rA.orgId}`)).body;
      expect(tree).toMatchObject({ messages: 21, parts: 23, delivered: 16, failed: 4, pending: 1, revenue_micros: 1660, cost_micros: 650, profit_micros: 1010 });
      expect(tree.delivery_rate).toBeCloseTo(16 / 21, 4);
      const b = (await as(ctx, admin).get(`/api/analytics/summary?${range}&org_id=${rB.orgId}`)).body;
      expect(b).toMatchObject({ messages: 8, revenue_micros: 700, cost_micros: 350, profit_micros: 350 });
    });

    it('reseller: revenue = its clients’ client_cost, cost = reseller_cost (incl. own sends)', async () => {
      const s = (await as(ctx, rA).get(`/api/analytics/summary?${range}`)).body;
      expect(s).toMatchObject({ messages: 21, delivered: 16, failed: 4, pending: 1, revenue_micros: 2100, cost_micros: 1660, profit_micros: 440 });
      const one = (await as(ctx, rA).get(`/api/analytics/summary?${range}&org_id=${cA2.orgId}`)).body;
      expect(one).toMatchObject({ messages: 4, revenue_micros: 400, cost_micros: 300, profit_micros: 100 });
      expect((await as(ctx, rA).get(`/api/analytics/summary?${range}&org_id=${cB.orgId}`)).status).toBe(403);
    });

    it('client: spend only', async () => {
      const s = (await as(ctx, cA1).get(`/api/analytics/summary?${range}`)).body;
      expect(s).toMatchObject({ messages: 15, parts: 17, delivered: 12, failed: 2, pending: 1, delivery_rate: 0.8, revenue_micros: 0, cost_micros: 1700, profit_micros: 0, spend_micros: 1700 });
      expect((await as(ctx, cA1).get(`/api/analytics/summary?org_id=${cA2.orgId}`)).status).toBe(403);
      const byRoute = (await as(ctx, cA1).get(`/api/analytics/summary?${range}&route_id=${R2}`)).body;
      expect(byRoute).toMatchObject({ messages: 5, cost_micros: 500 });
    });

    it('default window is the last 7 days', async () => {
      const s = (await as(ctx, cA1).get('/api/analytics/summary')).body;
      expect(s.messages).toBeLessThan(100);
      const wide = (await as(ctx, cA1).get(`/api/analytics/summary?from=${new Date(today0 - 40 * D).toISOString()}`)).body;
      expect(wide.messages).toBe(s.messages + 100);
    });
  });

  describe('timeseries', () => {
    it('hourly points fill gaps with zeros and sum to the summary', async () => {
      const from = new Date(today0 - 2 * D).toISOString();
      const to = new Date(today0 + 2 * H).toISOString();
      const res = await as(ctx, rA).get(`/api/analytics/timeseries?granularity=hour&from=${from}&to=${to}`);
      expect(res.status).toBe(200);
      expect(res.body.points).toHaveLength(50);
      const p1 = res.body.points.find((p: { t: string }) => p.t === h1.toISOString());
      expect(p1).toMatchObject({ messages: 14, delivered: 9, failed: 4, revenue_micros: 1600, cost_micros: 1100 });
      const sum = res.body.points.reduce((a: number, p: { messages: number }) => a + p.messages, 0);
      expect(sum).toBe(21);
      expect(res.body.points.filter((p: { messages: number }) => p.messages === 0)).toHaveLength(47);
      expect((await as(ctx, rA).get(`/api/analytics/timeseries?granularity=hour&from=${new Date(today0 - 40 * D).toISOString()}`)).status).toBe(400);
    });

    it('daily buckets follow the org timezone (Asia/Kolkata) unless tz is given', async () => {
      await as(ctx, cA1).patch(`/api/orgs/${cA1.orgId}`, { timezone: 'Asia/Kolkata' }).expect(200);
      const todayStr = new Date(today0).toISOString().slice(0, 10);
      const yStr = new Date(today0 - D).toISOString().slice(0, 10);
      const local = (await as(ctx, cA1).get(`/api/analytics/timeseries?granularity=day&${range}`)).body;
      expect(local.timezone).toBe('Asia/Kolkata');
      // hourly rollups + a +05:30 zone: the response states the approximation
      expect(local.day_boundary_shift_minutes).toBe(30);
      expect((await as(ctx, cA1).get(`/api/analytics/timeseries?granularity=day&tz=Asia/Kathmandu&${range}`)).body.day_boundary_shift_minutes).toBe(45);
      expect((await as(ctx, cA1).get(`/api/analytics/timeseries?granularity=day&tz=Europe/Berlin&${range}`)).body.day_boundary_shift_minutes).toBe(0);
      const byDate = (b: { points: { date: string; messages: number }[] }) => Object.fromEntries(b.points.map((p) => [p.date, p.messages]));
      expect(byDate(local)[todayStr]).toBe(10); // h1 (20:00Z yesterday) is 01:30 today in Kolkata
      expect(byDate(local)[yStr] ?? 0).toBe(0);
      const kolkataMidnight = local.points.find((p: { date: string }) => p.date === todayStr).t;
      expect(new Date(kolkataMidnight).toISOString()).toBe(new Date(today0 - 5.5 * H).toISOString());
      const utc = (await as(ctx, cA1).get(`/api/analytics/timeseries?granularity=day&tz=UTC&${range}`)).body;
      expect(byDate(utc)[yStr]).toBe(10);
      expect(utc.day_boundary_shift_minutes).toBe(0);
      expect(byDate(utc)[todayStr] ?? 0).toBe(0);
      expect(local.points[0].spend_micros).toBeDefined();
      expect((await as(ctx, cA1).get('/api/analytics/timeseries?tz=Mars/Base')).status).toBe(400);
    });
  });

  describe('breakdown', () => {
    const rows = async (s: Session, qs: string) => (await as(ctx, s).get(`/api/analytics/breakdown?${range}&${qs}`)).body.rows as Record<string, unknown>[];

    it('by route (labels) and by org (admin: per reseller tree; reseller: per client)', async () => {
      const route = await rows(admin, `by=route&org_id=${rA.orgId}`);
      expect(route.find((r) => r.key === R1)).toMatchObject({ messages: 16, delivered: 11, failed: 4, revenue_micros: 1260, cost_micros: 450 });
      expect((route.find((r) => r.key === R1) as { label: string }).label).toMatch(/^Route-One/);
      const orgsAdmin = await rows(admin, 'by=org');
      expect(orgsAdmin.find((r) => r.key === rA.orgId)).toMatchObject({ messages: 21, revenue_micros: 1660, cost_micros: 650 });
      expect(orgsAdmin.find((r) => r.key === rB.orgId)).toMatchObject({ messages: 8, revenue_micros: 700 });
      expect(orgsAdmin.find((r) => r.key === cA1.orgId)).toBeUndefined();
      const orgsReseller = await rows(rA, 'by=org');
      expect(orgsReseller.map((r) => [r.key, r.messages, r.revenue_micros, r.cost_micros])).toEqual([
        [cA1.orgId, 15, 1700, 1200],
        [cA2.orgId, 4, 400, 300],
        [rA.orgId, 2, 0, 160],
      ]);
    });

    it('by country and by status', async () => {
      const country = await rows(rA, 'by=country');
      expect(country.map((r) => [r.key, r.messages])).toEqual([
        ['IN', 16],
        ['GB', 5],
      ]);
      const status = await rows(cA1, 'by=status');
      expect(status.map((r) => [r.key, r.messages])).toEqual([
        ['DELIVERED', 12],
        ['UNDELIVERED', 1],
        ['FAILED', 1],
        ['PENDING', 1],
      ]);
      expect((await as(ctx, cA1).get('/api/analytics/breakdown?by=bogus')).status).toBe(400);
    });
  });

  describe('live (admin)', () => {
    it('aggregates engine connection status and the submit rate from engine metrics', async () => {
      const conn = (id: string, state: string, tps: number, q: number) => ({
        connection_id: id, name: id, enabled: true, state, sessions: [], tps_limit: 100, tps_current: tps, inflight: 1, queue_depth: q, submitted_total: 0, failed_total: 0,
      });
      ctx.engine.connections = [conn('a', 'BOUND', 12.5, 40), conn('b', 'DOWN', 0, 3), conn('c', 'BOUND', 7.25, 0)];
      ctx.engine.metricsSubmitTotal = 1000;
      const first = (await as(ctx, admin).get('/api/analytics/live')).body;
      expect(first).toMatchObject({ tps_in: 0, tps_out: 19.75, queue_depth: 43, connections_up: 2, connections_total: 3 });
      ctx.engine.metricsSubmitTotal = 1100;
      await new Promise((r) => setTimeout(r, 1000));
      ctx.engine.connections = [conn('a', 'BOUND', 12.5, 40), conn('b', 'DOWN', 0, 3), conn('c', 'BOUND', 7.25, 0)];
      const second = (await as(ctx, admin).get('/api/analytics/live')).body;
      expect(second.tps_in).toBeGreaterThan(70);
      expect(second.tps_in).toBeLessThanOrEqual(100);
      expect((await as(ctx, rA).get('/api/analytics/live')).status).toBe(403);
    });
  });

  describe('dashboard', () => {
    it('client: live balance, today, 7 local days, own counts', async () => {
      ctx.engine.balances.set(cA1.orgId, 3_000_000);
      const res = await as(ctx, cA1).get('/api/dashboard');
      expect(res.status).toBe(200);
      expect(res.body.balance).toMatchObject({ balance_micros: 3_000_000, source: 'engine' });
      expect(res.body.last7d).toHaveLength(7);
      expect(res.body.timezone).toBe('Asia/Kolkata');
      expect(res.body.today.messages).toBe(res.body.last7d[6].messages);
      expect(res.body.counts).toEqual({ routes: 0, api_keys: 0, campaigns_active: 0 });
    });

    it('reseller and admin counts; admin has no balance', async () => {
      const r = (await as(ctx, rA).get('/api/dashboard')).body;
      expect(r.counts).toEqual({ clients: 2, routes: 0 });
      expect(r.balance).not.toBeNull();
      ctx.engine.connections = [{ connection_id: 'x', state: 'BOUND' }, { connection_id: 'y', state: 'DOWN' }];
      const a = (await as(ctx, admin).get('/api/dashboard')).body;
      expect(a.balance).toBeNull();
      expect(a.counts.resellers).toBeGreaterThanOrEqual(2);
      expect(a.counts.clients).toBeGreaterThanOrEqual(3);
      expect(a.counts.routes).toBeGreaterThanOrEqual(2);
      expect(a.counts.connections_up).toBe(1);
      ctx.engine.down = true;
      expect((await as(ctx, admin).get('/api/dashboard')).body.counts.connections_up).toBeNull();
    });
  });

  describe('tester', () => {
    it('admin sends on a forced route with test=true; audited', async () => {
      const res = await as(ctx, admin).post('/api/tester/send', { route_id: R1, destination: '+91 98765 43210', text: 'Code 1234', source: 'TEST' });
      expect(res.status).toBe(201);
      expect(res.body.message_id).toEqual(expect.any(String));
      expect(ctx.engine.calls('/internal/v1/submit')[0].body).toEqual({
        org_id: admin.orgId, channel: 'WEB', source: 'TEST', destination: '919876543210', text: 'Code 1234', route_id: R1, test: true,
      });
      const audit = await ctx.db.selectFrom('audit_logs').selectAll().where('action', '=', 'tester.send').where('entity_id', '=', res.body.message_id).executeTakeFirst();
      expect(audit?.actor_user_id).toBe(admin.userId);
    });

    it('route must be visible; clients cannot use the tester', async () => {
      expect((await as(ctx, rA).post('/api/tester/send', { route_id: R1, destination: '919876543210', text: 'x', source: 'T' })).status).toBe(404);
      expect((await as(ctx, cA1).post('/api/tester/send', { route_id: R1, destination: '919876543210', text: 'x', source: 'T' })).status).toBe(403);
      expect(ctx.engine.calls('/internal/v1/submit')).toHaveLength(0);
    });

    it('GET /api/tester/:id returns the CDR and timings', async () => {
      const t0 = new Date(Date.now() - 10_000);
      const id = await insertMessage(ctx, {
        org_id: admin.orgId, route_id: R1, created_at: t0, status: 'DELIVERED',
        submitted_at: new Date(t0.getTime() + 1500), dlr_received_at: new Date(t0.getTime() + 4500),
      });
      const res = await as(ctx, admin).get(`/api/tester/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.message).toMatchObject({ id, status: 'DELIVERED' });
      expect(res.body.timings).toEqual({
        accepted_at: t0.toISOString(),
        submitted_at: new Date(t0.getTime() + 1500).toISOString(),
        dlr_received_at: new Date(t0.getTime() + 4500).toISOString(),
        submit_latency_ms: 1500,
        dlr_latency_ms: 3000,
        total_latency_ms: 4500,
      });
      const pending = await insertMessage(ctx, { org_id: admin.orgId, created_at: new Date() });
      expect((await as(ctx, admin).get(`/api/tester/${pending}`)).body.timings).toMatchObject({ submit_latency_ms: null, dlr_latency_ms: null });
      expect((await as(ctx, rA).get(`/api/tester/${id}`)).status).toBe(404);
    });
  });
});

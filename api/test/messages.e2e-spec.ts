import { parse } from 'csv-parse/sync';
import { sql } from 'kysely';
import { Session, TestCtx, adminLogin, as, createChild, insertMessage, setup, uniq } from './helpers';

const H = 3_600_000;

/** /api/messages: keyset pagination, tenancy, filters, detail, CSV export, web quick send. */
describe('messages & reports', () => {
  let ctx: TestCtx;
  let admin: Session;
  let rA: Session;
  let cA1: Session;
  let cA2: Session;
  let rB: Session;
  let cB: Session;
  const ids: Record<string, string[]> = { cA1: [], cA2: [], rA: [], cB: [] };
  let oldId: string;
  const now = Date.now();

  beforeAll(async () => {
    ctx = await setup();
    admin = await adminLogin(ctx);
    rA = await createChild(ctx, admin, uniq('msg-rA'));
    rB = await createChild(ctx, admin, uniq('msg-rB'));
    cA1 = await createChild(ctx, rA, uniq('msg-cA1'));
    cA2 = await createChild(ctx, rA, uniq('msg-cA2'));
    cB = await createChild(ctx, rB, uniq('msg-cB'));

    // cA1: 7 messages; three share one timestamp to exercise the (created_at, id) tie-break.
    const shared = new Date(now - 5 * H);
    const statuses = ['DELIVERED', 'DELIVERED', 'FAILED', 'SUBMITTED', 'UNDELIVERED', 'DELIVERED', 'ACCEPTED'] as const;
    for (let i = 0; i < 7; i++) {
      ids.cA1.push(
        await insertMessage(ctx, {
          org_id: cA1.orgId,
          reseller_id: rA.orgId,
          created_at: i >= 2 && i <= 4 ? shared : new Date(now - (i + 1) * H),
          status: statuses[i],
          destination_addr: i === 0 ? '447700900123' : `91987654${String(i).padStart(4, '0')}`,
          source_addr: i % 2 === 0 ? 'AcmeBank' : '15551234567',
          channel: i === 6 ? 'SMPP' : 'HTTP',
          orig_text: i === 1 ? 'Your OTP is 4821' : `msg ${i}`,
          client_rate_micros: 12_345,
          client_cost_micros: 12_345,
          reseller_cost_micros: 8000,
          route_cost_micros: 3000,
        }),
      );
    }
    for (let i = 0; i < 3; i++) ids.cA2.push(await insertMessage(ctx, { org_id: cA2.orgId, reseller_id: rA.orgId, created_at: new Date(now - (i + 2) * H) }));
    ids.rA.push(await insertMessage(ctx, { org_id: rA.orgId, reseller_id: rA.orgId, created_at: new Date(now - 3 * H) }));
    for (let i = 0; i < 2; i++) ids.cB.push(await insertMessage(ctx, { org_id: cB.orgId, reseller_id: rB.orgId, created_at: new Date(now - 4 * H) }));
    oldId = await insertMessage(ctx, { org_id: cA1.orgId, reseller_id: rA.orgId, created_at: new Date(now - 10 * 24 * H) });
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(() => ctx.engine.reset());

  async function all(s: Session, query: string, limit = 3): Promise<{ id: string; created_at: string }[]> {
    const out: { id: string; created_at: string }[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 100; guard++) {
      const res = await as(ctx, s).get(`/api/messages?limit=${limit}${query}${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.status).toBe(200);
      expect(res.body.items.length).toBeLessThanOrEqual(limit);
      out.push(...res.body.items);
      cursor = res.body.next_cursor;
      if (!cursor) return out;
    }
    throw new Error('pagination did not terminate');
  }

  describe('cursor pagination', () => {
    it('pages over (created_at DESC, id DESC) without gaps or duplicates, default window = last 7 days', async () => {
      const full = await as(ctx, cA1).get('/api/messages?limit=100');
      expect(full.body.next_cursor).toBeNull();
      const fullIds = full.body.items.map((m: { id: string }) => m.id);
      expect(fullIds.sort()).toEqual([...ids.cA1].sort());
      expect(fullIds).not.toContain(oldId);

      const paged = await all(cA1, '', 3);
      expect(paged.map((m) => m.id)).toEqual(full.body.items.map((m: { id: string }) => m.id));
      for (let i = 1; i < paged.length; i++) {
        const a = paged[i - 1];
        const b = paged[i];
        expect(a.created_at > b.created_at || (a.created_at === b.created_at && a.id > b.id)).toBe(true);
      }
      // limit 1 walks through the three rows sharing a timestamp one by one
      expect((await all(cA1, '', 1)).map((m) => m.id)).toEqual(paged.map((m) => m.id));
    });

    it('explicit date bounds reach older partitions; ranges are capped', async () => {
      const from = new Date(now - 15 * 24 * H).toISOString();
      const res = await all(cA1, `&from_date=${encodeURIComponent(from)}`, 5);
      expect(res.map((m) => m.id)).toContain(oldId);
      const dateOnly = new Date(now - 10 * 24 * H).toISOString().slice(0, 10);
      const day = await as(ctx, cA1).get(`/api/messages?from_date=${dateOnly}&to_date=${dateOnly}`);
      expect(day.body.items.map((m: { id: string }) => m.id)).toEqual([oldId]);
      expect((await as(ctx, cA1).get('/api/messages?from_date=2020-01-01&to_date=2026-01-01')).status).toBe(400);
      expect((await as(ctx, cA1).get('/api/messages?from_date=2026-02-01&to_date=2026-01-01')).status).toBe(400);
      expect((await as(ctx, cA1).get('/api/messages?from_date=yesterday')).status).toBe(400);
    });

    it('malformed cursor → 400', async () => {
      const res = await as(ctx, cA1).get('/api/messages?cursor=bm9wZQ');
      expect(res.status).toBe(400);
      expect(res.body.error_code).toBe('INVALID_REQUEST');
    });
  });

  describe('tenancy', () => {
    it('client sees only its own messages; other org_id → 403', async () => {
      const res = await all(cA2, '', 50);
      expect(res.map((m) => m.id).sort()).toEqual([...ids.cA2].sort());
      expect((await as(ctx, cA2).get(`/api/messages?org_id=${cA1.orgId}`)).status).toBe(403);
    });

    it('reseller sees its clients and its own sends, not another reseller’s', async () => {
      const res = await all(rA, '', 4);
      expect(res.map((m) => m.id).sort()).toEqual([...ids.cA1, ...ids.cA2, ...ids.rA].sort());
      const one = await all(rA, `&org_id=${cA2.orgId}`, 50);
      expect(one.map((m) => m.id).sort()).toEqual([...ids.cA2].sort());
      expect((await as(ctx, rA).get(`/api/messages?org_id=${cB.orgId}`)).status).toBe(403);
      expect((await as(ctx, rA).get(`/api/messages?org_id=${rB.orgId}`)).status).toBe(403);
    });

    it('admin sees everything; org_id of a reseller = its tree', async () => {
      const res = await all(admin, '', 50);
      const got = new Set(res.map((m) => m.id));
      for (const id of [...ids.cA1, ...ids.cA2, ...ids.rA, ...ids.cB]) expect(got.has(id)).toBe(true);
      const tree = await all(admin, `&org_id=${rB.orgId}`, 50);
      expect(tree.map((m) => m.id).sort()).toEqual([...ids.cB].sort());
    });

    it('detail: own / child visible, others 404', async () => {
      expect((await as(ctx, cA1).get(`/api/messages/${ids.cA1[0]}`)).status).toBe(200);
      expect((await as(ctx, cA1).get(`/api/messages/${ids.cA2[0]}`)).status).toBe(404);
      expect((await as(ctx, rA).get(`/api/messages/${ids.cA1[0]}`)).status).toBe(200);
      expect((await as(ctx, rB).get(`/api/messages/${ids.cA1[0]}`)).status).toBe(404);
      expect((await as(ctx, admin).get(`/api/messages/${ids.cB[0]}`)).status).toBe(200);
      expect((await as(ctx, cA1).get('/api/messages/123')).status).toBe(404);
    });

    it('costs are redacted per role', async () => {
      const c = (await as(ctx, cA1).get(`/api/messages/${ids.cA1[0]}`)).body;
      expect(c).toMatchObject({ client_cost_micros: 12_345, reseller_cost_micros: null, route_cost_micros: null, connection_id: null, smsc_msg_ids: [] });
      expect(c.org_name).toBeDefined();
      const r = (await as(ctx, rA).get(`/api/messages/${ids.cA1[0]}`)).body;
      expect(r).toMatchObject({ client_cost_micros: 12_345, reseller_cost_micros: 8000, route_cost_micros: null });
      const a = (await as(ctx, admin).get(`/api/messages/${ids.cA1[0]}`)).body;
      expect(a).toMatchObject({ client_cost_micros: 12_345, reseller_cost_micros: 8000, route_cost_micros: 3000 });
    });
  });

  describe('filters', () => {
    const q = async (s: Session, qs: string) => (await as(ctx, s).get(`/api/messages?limit=100&${qs}`)).body.items.map((m: { id: string }) => m.id).sort();

    it('status (list), destination exact/prefix, source, channel, q', async () => {
      expect(await q(cA1, 'status=DELIVERED')).toEqual([ids.cA1[0], ids.cA1[1], ids.cA1[5]].sort());
      expect(await q(cA1, 'status=failed,UNDELIVERED')).toEqual([ids.cA1[2], ids.cA1[4]].sort());
      expect((await as(ctx, cA1).get('/api/messages?status=BOGUS')).status).toBe(400);
      expect(await q(cA1, `destination=${encodeURIComponent('+44 7700 900123')}`)).toEqual([ids.cA1[0]]);
      expect(await q(cA1, 'destination=4477')).toEqual([ids.cA1[0]]);
      expect(await q(cA1, 'source=acmebank')).toEqual([ids.cA1[0], ids.cA1[2], ids.cA1[4], ids.cA1[6]].sort());
      expect(await q(cA1, `source=${encodeURIComponent('+15551234567')}`)).toEqual([ids.cA1[1], ids.cA1[3], ids.cA1[5]].sort());
      expect(await q(cA1, 'channel=SMPP')).toEqual([ids.cA1[6]]);
      expect(await q(cA1, 'q=otp')).toEqual([ids.cA1[1]]);
      expect(await q(cA1, `q=${ids.cA1[3]}`)).toEqual([ids.cA1[3]]);
      expect(await q(cA1, 'q=100%25')).toEqual([]); // LIKE wildcards are literal
    });
  });

  describe('CSV export', () => {
    const exportCsv = async (s: Session, qs = '') => {
      const res = await as(ctx, s)
        .get(`/api/messages/export${qs}`)
        .buffer(true)
        .parse((r, cb) => {
          let data = '';
          r.setEncoding('utf8');
          r.on('data', (c: string) => (data += c));
          r.on('end', () => cb(null, data));
        });
      return res;
    };

    it('streams text/csv with escaping, formula guard, decimal money and role columns', async () => {
      const tricky = await insertMessage(ctx, {
        org_id: cA1.orgId,
        reseller_id: rA.orgId,
        created_at: new Date(now - 30 * 60_000),
        orig_text: 'Hello, "world"\nline two',
        sent_text: '=HYPERLINK("x")',
        client_msg_ref: 'ref,1',
        client_cost_micros: 1_234_567,
        reseller_cost_micros: 5,
        route_cost_micros: 1,
      });
      const res = await exportCsv(cA1);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/csv/);
      expect(res.headers['content-disposition']).toMatch(/attachment; filename="messages-.*\.csv"/);
      const text = res.body as string;
      expect(text.charCodeAt(0)).toBe(0xfeff);
      expect(text).toContain('"Hello, ""world""\nline two"');
      const rows = parse(text, { bom: true, columns: true }) as Record<string, string>[];
      expect(rows).toHaveLength(8);
      expect(Object.keys(rows[0])).not.toContain('reseller_cost');
      expect(Object.keys(rows[0])).not.toContain('route_cost');
      const t = rows.find((r) => r.message_id === tricky)!;
      expect(t.text).toBe('Hello, "world"\nline two');
      expect(t.sent_text).toBe(`'=HYPERLINK("x")`);
      expect(t.client_ref).toBe('ref,1');
      expect(t.cost).toBe('1.234567');
      expect(rows.find((r) => r.message_id === ids.cA1[0])!.cost).toBe('0.012345');
      expect(rows.map((r) => r.message_id)).toEqual([tricky, ...(await as(ctx, cA1).get('/api/messages?limit=100')).body.items.map((m: { id: string }) => m.id).filter((id: string) => id !== tricky)]);

      const reseller = parse((await exportCsv(rA)).body as string, { bom: true, columns: true }) as Record<string, string>[];
      expect(reseller).toHaveLength(12);
      expect(reseller.find((r) => r.message_id === tricky)).toMatchObject({ cost: '1.234567', reseller_cost: '0.000005' });
      expect(Object.keys(reseller[0])).not.toContain('route_cost');
      const adminRows = parse((await exportCsv(admin, `?org_id=${rA.orgId}&status=ACCEPTED`)).body as string, { bom: true, columns: true }) as Record<string, string>[];
      expect(adminRows.find((r) => r.message_id === tricky)).toMatchObject({ route_cost: '0.000001' });
    });

    it('exports beyond one keyset batch (12,000 rows) exactly once each', async () => {
      const big = await createChild(ctx, rA, uniq('msg-big'));
      await sql`
        insert into message_logs (org_id, reseller_id, channel, destination_addr, orig_text, created_at)
        select ${big.orgId}::uuid, ${rA.orgId}::uuid, 'HTTP', '4477009' || lpad(g::text, 5, '0'), 'bulk ' || g,
               now() - (g % 4000) * interval '1 minute'
          from generate_series(1, 12000) g`.execute(ctx.db);
      const res = await exportCsv(big);
      expect(res.status).toBe(200);
      const rows = parse(res.body as string, { bom: true, columns: true }) as Record<string, string>[];
      expect(rows).toHaveLength(12000);
      expect(new Set(rows.map((r) => r.message_id)).size).toBe(12000);
    });

    it('validation errors are JSON, not CSV', async () => {
      const res = await as(ctx, cA1).get('/api/messages/export?org_id=' + cB.orgId);
      expect(res.status).toBe(403);
      expect(res.body.error_code).toBe('FORBIDDEN');
    });
  });

  describe('web quick send', () => {
    it('client sends on channel WEB (single → /submit, list → /submit/batch)', async () => {
      const one = await as(ctx, cA1).post('/api/messages/send', { to: '+447700900001', from: 'ACME', text: 'hi', route_id: '00000000-0000-4000-8000-000000000001' });
      expect(one.status).toBe(201);
      expect(one.body.messages[0]).toMatchObject({ to: '447700900001', status: 'ACCEPTED' });
      expect(ctx.engine.calls('/internal/v1/submit')[0].body).toEqual({
        org_id: cA1.orgId,
        channel: 'WEB',
        source: 'ACME',
        destination: '447700900001',
        text: 'hi',
        route_id: '00000000-0000-4000-8000-000000000001',
      });
      const many = await as(ctx, cA1).post('/api/messages/send', { to: ['447700900001', '447700900002'], from: 'ACME', text: 'hi' });
      expect(many.body.messages).toHaveLength(2);
      expect(ctx.engine.calls('/internal/v1/submit/batch')).toHaveLength(1);
    });

    it('rejections keep the engine status; the admin cannot quick-send', async () => {
      ctx.engine.rejectAll = { status: 422, error_code: 'ROUTE_NOT_FOUND', message: 'no route' };
      const res = await as(ctx, cA1).post('/api/messages/send', { to: '447700900001', from: 'ACME', text: 'hi' });
      expect(res.status).toBe(422);
      expect(res.body.error_code).toBe('ROUTE_NOT_FOUND');
      expect((await as(ctx, admin).post('/api/messages/send', { to: '447700900001', from: 'ACME', text: 'hi' })).status).toBe(403);
    });
  });
});

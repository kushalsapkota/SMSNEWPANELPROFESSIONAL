import { CampaignWorker } from '../src/campaigns/campaign-worker.service';
import { Session, TestCtx, adminLogin, as, createChild, setup, uniq } from './helpers';

describe('campaigns', () => {
  let ctx: TestCtx;
  let admin: Session;
  let reseller: Session;
  let client: Session;
  let otherReseller: Session;
  let worker: CampaignWorker;

  beforeAll(async () => {
    ctx = await setup();
    admin = await adminLogin(ctx);
    reseller = await createChild(ctx, admin, uniq('cmp-r'));
    otherReseller = await createChild(ctx, admin, uniq('cmp-r2'));
    client = await createChild(ctx, reseller, uniq('cmp-c'));
    worker = ctx.app.get(CampaignWorker);
    worker.paceMs = 0;
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(() => ctx.engine.reset());

  const upload = (s: Session, csv: string, fields: Record<string, string>) => {
    let r = ctx.http().post('/api/campaigns').set('Authorization', `Bearer ${s.token}`).attach('file', Buffer.from(csv, 'utf8'), 'list.csv');
    for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
    return r;
  };
  const batchItems = () => ctx.engine.calls('/internal/v1/submit/batch').map((c) => (c.body as { items: Record<string, string>[] }).items);
  const recipients = async (id: string) =>
    ctx.db.selectFrom('campaign_recipients').selectAll().where('campaign_id', '=', id).orderBy('seq').execute();
  const campaign = async (id: string) => ctx.db.selectFrom('campaigns').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  const createJson = async (n: number, extra: Record<string, unknown> = {}) => {
    const res = await as(ctx, client).post('/api/campaigns', {
      name: uniq('json'),
      source_addr: 'ACME',
      body: 'Hello {name}',
      recipients: Array.from({ length: n }, (_, i) => ({ phone: `4477009${String(i).padStart(5, '0')}`, name: `N${i}` })),
      ...extra,
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  describe('CSV / JSON import', () => {
    it('parses CSV: phone column, normalisation, dedupe, invalid rows, {column} vars', async () => {
      const csv = [
        'Phone,First Name,Order',
        '+91 98765 43210,Asha,"A-1, B"',
        '919876543210,Dup,X',
        'not-a-phone,Bob,1',
        ',Empty,2',
        '447700900001,Ben,"Q""uote"',
        '',
      ].join('\r\n');
      const res = await upload(client, '﻿' + csv, { name: 'Spring sale', source_addr: 'ACME', body: 'Hi {first_name}, order {Order}' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ name: 'Spring sale', status: 'DRAFT', total: 2, submitted: 0, failed: 0, pending: 2, org_id: client.orgId });
      expect(res.body.import).toEqual({
        columns: ['first_name', 'order'],
        invalid_rows: 2,
        duplicate_rows: 1,
        errors: [
          { row: 4, phone: 'not-a-phone', reason: 'invalid phone number' },
          { row: 5, phone: '', reason: 'phone is empty' },
        ],
      });
      const rows = await recipients(res.body.id);
      expect(rows.map((r) => [r.seq, r.destination, r.vars])).toEqual([
        [1, '919876543210', { first_name: 'Asha', order: 'A-1, B' }],
        [2, '447700900001', { first_name: 'Ben', order: 'Q"uote' }],
      ]);
      const audit = await ctx.db.selectFrom('audit_logs').select('action').where('entity_id', '=', res.body.id).execute();
      expect(audit.map((a) => a.action)).toEqual(['campaign.create']);
    });

    it('semicolon-delimited files work; header must contain phone; placeholders must exist', async () => {
      const ok = await upload(client, 'phone;name\n447700900001;Zed\n', { name: 'semi', source_addr: 'ACME', body: 'Yo {name}' });
      expect(ok.status).toBe(201);
      expect(ok.body.total).toBe(1);
      const noPhone = await upload(client, 'mobile,name\n447700900001,x\n', { name: 'x', source_addr: 'ACME', body: 'hi' });
      expect(noPhone.status).toBe(400);
      expect(noPhone.body.message).toMatch(/phone/);
      const badVar = await upload(client, 'phone,name\n447700900001,x\n', { name: 'x', source_addr: 'ACME', body: 'hi {nmae}' });
      expect(badVar.status).toBe(400);
      expect(badVar.body.details.unknown_placeholders).toEqual(['nmae']);
      const none = await upload(client, 'phone\nnope\n', { name: 'x', source_addr: 'ACME', body: 'hi' });
      expect(none.status).toBe(400);
      expect(none.body.message).toMatch(/No valid recipients/);
      const missingFields = await upload(client, 'phone\n447700900001\n', { name: 'x' });
      expect(missingFields.status).toBe(400);
      const neither = await as(ctx, client).post('/api/campaigns', { name: 'x', source_addr: 'ACME', body: 'hi' });
      expect(neither.status).toBe(400);
    });

    it('large uploads (20,000 rows) are inserted in batches', async () => {
      const lines = ['phone,n', ...Array.from({ length: 20_000 }, (_, i) => `4478${String(i).padStart(8, '0')},${i}`)];
      const res = await upload(client, lines.join('\n'), { name: 'big', source_addr: 'ACME', body: 'n={n}' });
      expect(res.status).toBe(201);
      expect(res.body.total).toBe(20_000);
      const { n } = await ctx.db.selectFrom('campaign_recipients').select((eb) => eb.fn.countAll<number>().as('n')).where('campaign_id', '=', res.body.id).executeTakeFirstOrThrow();
      expect(n).toBe(20_000);
      const last = await ctx.db.selectFrom('campaign_recipients').selectAll().where('campaign_id', '=', res.body.id).where('seq', '=', 20_000).executeTakeFirstOrThrow();
      expect(last).toMatchObject({ destination: '447800019999', vars: { n: '19999' } });
      await as(ctx, client).post(`/api/campaigns/${res.body.id}/cancel`).expect(200);
    });

    it('JSON variant with scheduled_at → SCHEDULED; admin cannot create', async () => {
      const at = new Date(Date.now() + 3600_000).toISOString();
      const res = await as(ctx, client).post('/api/campaigns', { name: 'later', source_addr: 'ACME', body: 'Hi {name}', scheduled_at: at, recipients: [{ phone: '447700900001', name: 'A' }, { phone: '+447700900001', name: 'dup' }] });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ status: 'SCHEDULED', total: 1, scheduled_at: at });
      expect(res.body.import.duplicate_rows).toBe(1);
      expect((await as(ctx, admin).post('/api/campaigns', { name: 'x', source_addr: 'A', body: 'b', recipients: [{ phone: '447700900001' }] })).status).toBe(403);
    });
  });

  describe('worker', () => {
    it('start → submits rendered texts via /submit/batch, records message ids, completes', async () => {
      const res = await upload(client, 'phone,name,code\n447700900001,Ann,"X,1"\n447700900002,Bo,Y\n', { name: 'go', source_addr: 'ACME', body: 'Hi {name}: {code}' });
      const id = res.body.id;
      expect((await worker.tick()).find((o) => o.campaignId === id)).toBeUndefined(); // DRAFT is not sent
      const started = await as(ctx, client).post(`/api/campaigns/${id}/start`);
      expect(started.status).toBe(200);
      expect(started.body.status).toBe('RUNNING');
      expect(started.body.started_at).not.toBeNull();

      const out = await worker.tick();
      expect(out.find((o) => o.campaignId === id)).toMatchObject({ submitted: 2, failed: 0, status: 'COMPLETED' });
      expect(batchItems()).toEqual([
        [
          { org_id: client.orgId, channel: 'WEB', source: 'ACME', destination: '447700900001', text: 'Hi Ann: X,1', campaign_id: id },
          { org_id: client.orgId, channel: 'WEB', source: 'ACME', destination: '447700900002', text: 'Hi Bo: Y', campaign_id: id },
        ],
      ]);
      expect((await recipients(id)).every((r) => r.message_id && !r.error_code)).toBe(true);
      const c = await as(ctx, client).get(`/api/campaigns/${id}`);
      expect(c.body).toMatchObject({ status: 'COMPLETED', submitted: 2, failed: 0, pending: 0 });
      expect(c.body.finished_at).not.toBeNull();
      expect((await as(ctx, client).post(`/api/campaigns/${id}/start`)).status).toBe(409);
    });

    it('chunks respect the org max_tps and pacing', async () => {
      await as(ctx, reseller).patch(`/api/orgs/${client.orgId}`, { max_tps: 2 }).expect(200);
      try {
        const id = await createJson(5);
        await as(ctx, client).post(`/api/campaigns/${id}/start`).expect(200);
        expect((await worker.tick()).find((o) => o.campaignId === id)).toMatchObject({ submitted: 2, status: 'RUNNING' });

        worker.paceMs = 60_000; // just processed → not due again yet
        expect((await worker.tick()).find((o) => o.campaignId === id)).toBeUndefined();
        worker.paceMs = 0;

        expect((await worker.tick()).find((o) => o.campaignId === id)).toMatchObject({ submitted: 2, status: 'RUNNING' });
        expect((await worker.tick()).find((o) => o.campaignId === id)).toMatchObject({ submitted: 1, status: 'COMPLETED' });
        const sent = batchItems().flat().filter((i) => i.campaign_id === id);
        expect(batchItems().every((items) => items.length <= 2)).toBe(true);
        expect(sent.map((i) => i.destination)).toEqual(['447700900000', '447700900001', '447700900002', '447700900003', '447700900004']);
        expect(sent.map((i) => i.text)).toEqual(['Hello N0', 'Hello N1', 'Hello N2', 'Hello N3', 'Hello N4']);
        expect(await campaign(id)).toMatchObject({ status: 'COMPLETED', submitted: 5, failed: 0 });
      } finally {
        worker.paceMs = 0;
        await as(ctx, reseller).patch(`/api/orgs/${client.orgId}`, { max_tps: 10 }).expect(200);
      }
    });

    it('multi-instance safety: a campaign leased by another instance is skipped, concurrent ticks never double-send', async () => {
      const id = await createJson(4);
      await as(ctx, client).post(`/api/campaigns/${id}/start`).expect(200);
      // Another "instance" holds the lease (row lock) while this one ticks.
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let locked!: () => void;
      const isLocked = new Promise<void>((r) => (locked = r));
      const other = ctx.db.transaction().execute(async (trx) => {
        await trx.selectFrom('campaigns').select('id').where('id', '=', id).forUpdate().execute();
        locked();
        await held;
      });
      await isLocked;
      const t0 = Date.now();
      expect((await worker.tick()).find((o) => o.campaignId === id)).toBeUndefined();
      expect(Date.now() - t0).toBeLessThan(2000); // skipped, not blocked
      release();
      await other;

      const [a, b] = await Promise.all([worker.tick(), worker.tick()]);
      expect([...a, ...b].filter((o) => o.campaignId === id).reduce((n, o) => n + o.submitted, 0)).toBe(4);
      const dests = batchItems().flat().filter((i) => i.campaign_id === id).map((i) => i.destination);
      expect(dests).toHaveLength(4);
      expect(new Set(dests).size).toBe(4);
      expect(await campaign(id)).toMatchObject({ submitted: 4 });
    });

    it('per-recipient rejections are recorded as failures; all rejected → FAILED', async () => {
      ctx.engine.rejects.set('447700900001', { status: 422, error_code: 'DESTINATION_BLOCKED', message: 'blocked' });
      const id = await createJson(3);
      await as(ctx, client).post(`/api/campaigns/${id}/start`).expect(200);
      expect((await worker.tick()).find((o) => o.campaignId === id)).toMatchObject({ submitted: 2, failed: 1, status: 'COMPLETED' });
      expect((await recipients(id)).map((r) => r.error_code)).toEqual([null, 'DESTINATION_BLOCKED', null]);
      expect(await campaign(id)).toMatchObject({ submitted: 2, failed: 1 });

      ctx.engine.rejectAll = { status: 422, error_code: 'SENDER_NOT_ALLOWED', message: 'no' };
      const bad = await createJson(2);
      await as(ctx, client).post(`/api/campaigns/${bad}/start`).expect(200);
      await worker.tick();
      expect(await campaign(bad)).toMatchObject({ status: 'FAILED', submitted: 0, failed: 2 });
    });

    it('org-level rejection (INSUFFICIENT_FUNDS) pauses and keeps recipients pending; resume completes', async () => {
      ctx.engine.rejectAll = { status: 422, error_code: 'INSUFFICIENT_FUNDS', message: 'low' };
      const id = await createJson(3);
      await as(ctx, client).post(`/api/campaigns/${id}/start`).expect(200);
      expect((await worker.tick()).find((o) => o.campaignId === id)).toMatchObject({ deferred: 3, status: 'PAUSED' });
      expect(await campaign(id)).toMatchObject({ status: 'PAUSED', submitted: 0, failed: 0 });
      expect((await recipients(id)).every((r) => !r.message_id && !r.error_code)).toBe(true);
      const audit = await ctx.db.selectFrom('audit_logs').selectAll().where('action', '=', 'campaign.auto_pause').where('entity_id', '=', id).executeTakeFirstOrThrow();
      expect(audit.after).toEqual({ status: 'PAUSED', reason: 'INSUFFICIENT_FUNDS' });
      expect(audit.target_org_id).toBe(client.orgId);

      ctx.engine.rejectAll = null;
      await as(ctx, client).post(`/api/campaigns/${id}/start`).expect(200);
      expect((await worker.tick()).find((o) => o.campaignId === id)).toMatchObject({ submitted: 3, status: 'COMPLETED' });
    });

    it('RATE_LIMITED and engine outages are retried later; nothing is lost', async () => {
      const id = await createJson(2);
      await as(ctx, client).post(`/api/campaigns/${id}/start`).expect(200);
      ctx.engine.rejectAll = { status: 429, error_code: 'RATE_LIMITED', message: 'slow down' };
      expect((await worker.tick()).find((o) => o.campaignId === id)).toMatchObject({ deferred: 2, status: 'RUNNING' });
      ctx.engine.rejectAll = null;
      ctx.engine.down = true;
      expect((await worker.tick()).find((o) => o.campaignId === id)).toMatchObject({ deferred: 2, status: 'RUNNING' });
      ctx.engine.down = false;
      expect((await worker.tick()).find((o) => o.campaignId === id)).toMatchObject({ submitted: 2, status: 'COMPLETED' });
      expect(await campaign(id)).toMatchObject({ submitted: 2, failed: 0 });
    });

    it('suspended org: the campaign is paused without calling the engine', async () => {
      const id = await createJson(1);
      await as(ctx, client).post(`/api/campaigns/${id}/start`).expect(200);
      await as(ctx, reseller).patch(`/api/orgs/${client.orgId}/channels`, { sending_enabled: false }).expect(200);
      expect((await worker.tick()).find((o) => o.campaignId === id)).toMatchObject({ status: 'PAUSED' });
      expect(ctx.engine.calls('/internal/v1/submit/batch')).toHaveLength(0);
      await as(ctx, reseller).patch(`/api/orgs/${client.orgId}/channels`, { sending_enabled: true }).expect(200);
    });

    it('due SCHEDULED campaigns are promoted and sent', async () => {
      const id = await createJson(1, { scheduled_at: new Date(Date.now() + 3600_000).toISOString() });
      await worker.tick();
      expect((await campaign(id)).status).toBe('SCHEDULED');
      await ctx.db.updateTable('campaigns').set({ scheduled_at: new Date(Date.now() - 1000) }).where('id', '=', id).execute();
      expect((await worker.tick()).find((o) => o.campaignId === id)).toMatchObject({ submitted: 1, status: 'COMPLETED' });
      expect((await campaign(id)).started_at).not.toBeNull();
    });
  });

  describe('pause / cancel / tenancy', () => {
    it('pause stops sending; cancel is final', async () => {
      const id = await createJson(2);
      expect((await as(ctx, client).post(`/api/campaigns/${id}/pause`)).status).toBe(409); // DRAFT
      await as(ctx, client).post(`/api/campaigns/${id}/start`).expect(200);
      const paused = await as(ctx, client).post(`/api/campaigns/${id}/pause`);
      expect(paused.body.status).toBe('PAUSED');
      expect((await worker.tick()).find((o) => o.campaignId === id)).toBeUndefined();
      const cancelled = await as(ctx, client).post(`/api/campaigns/${id}/cancel`);
      expect(cancelled.body.status).toBe('CANCELLED');
      expect(cancelled.body.finished_at).not.toBeNull();
      expect((await as(ctx, client).post(`/api/campaigns/${id}/start`)).status).toBe(409);
      expect((await as(ctx, client).post(`/api/campaigns/${id}/cancel`)).status).toBe(409);
      expect(ctx.engine.calls('/internal/v1/submit/batch')).toHaveLength(0);
      const actions = (await ctx.db.selectFrom('audit_logs').select('action').where('entity_id', '=', id).orderBy('id').execute()).map((a) => a.action);
      expect(actions).toEqual(['campaign.create', 'campaign.start', 'campaign.pause', 'campaign.cancel']);
    });

    it('reseller sees and controls its client’s campaigns; other resellers get 404', async () => {
      const id = await createJson(1);
      const list = await as(ctx, reseller).get('/api/campaigns?page_size=200');
      expect(list.body.items.map((c: { id: string }) => c.id)).toContain(id);
      const filtered = await as(ctx, reseller).get(`/api/campaigns?org_id=${client.orgId}&status=DRAFT`);
      expect(filtered.body.items.every((c: { status: string; org_id: string }) => c.status === 'DRAFT' && c.org_id === client.orgId)).toBe(true);
      expect((await as(ctx, reseller).post(`/api/campaigns/${id}/cancel`)).status).toBe(200);
      expect((await as(ctx, otherReseller).get(`/api/campaigns/${id}`)).status).toBe(404);
      expect((await as(ctx, otherReseller).post(`/api/campaigns/${id}/start`)).status).toBe(404);
      expect((await as(ctx, otherReseller).get('/api/campaigns')).body.items).toEqual([]);
      const rec = await as(ctx, client).get(`/api/campaigns/${id}/recipients?state=pending`);
      expect(rec.body).toMatchObject({ total: 1, items: [{ seq: 1, destination: '447700900000', vars: { name: 'N0' }, message_id: null, error_code: null }] });
    });
  });
});

import { randomUUID } from 'node:crypto';
import { AlertSender } from '../src/alerts/alert-sender.service';
import { AlertsWorker } from '../src/alerts/alerts-worker.service';
import { RedisService } from '../src/redis/redis.module';
import { Session, TestCtx, adminLogin, as, createChild, setup, uniq } from './helpers';

/** Low-balance and route-down notifications (Telegram via a fake Bot API, email via a mock transport). */
describe('alerts worker', () => {
  let ctx: TestCtx;
  let admin: Session;
  let reseller: Session;
  let client: Session & { email: string };
  let quiet: Session;
  let worker: AlertsWorker;
  let redis: RedisService;
  const mails: { to: string; subject: string; text: string }[] = [];

  beforeAll(async () => {
    ctx = await setup({ env: (url) => ({ TELEGRAM_BOT_TOKEN: '123456:test-token', TELEGRAM_API_URL: url }) });
    admin = await adminLogin(ctx);
    reseller = await createChild(ctx, admin, uniq('al-r'));
    client = await createChild(ctx, reseller, uniq('al-c'));
    quiet = await createChild(ctx, reseller, uniq('al-q'));
    worker = ctx.app.get(AlertsWorker);
    redis = ctx.app.get(RedisService);
    ctx.app.get(AlertSender).transporter = {
      sendMail: async (m: { to: string; subject: string; text: string }) => {
        mails.push(m);
        return {} as never;
      },
    } as never;

    await as(ctx, reseller).patch(`/api/orgs/${client.orgId}/billing`, { low_balance_alert_micros: 1_000_000 }).expect(200);
    await as(ctx, client).put('/api/notifications/settings', { telegram_enabled: true, telegram_chat_id: '987654' }).expect(200);
    await as(ctx, reseller).patch(`/api/orgs/${quiet.orgId}/billing`, { low_balance_alert_micros: 1_000_000 }).expect(200);
    await as(ctx, quiet).put('/api/notifications/settings', { low_balance: false }).expect(200);
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(() => {
    ctx.engine.reset();
    mails.length = 0;
  });

  it('low balance: telegram + email (owner address), at most once per window', async () => {
    const out = await worker.lowBalance();
    const alert = out.find((o) => o.org_id === client.orgId);
    expect(alert).toEqual({ kind: 'low_balance', org_id: client.orgId, subject_id: client.orgId, channels: ['email', 'telegram'] });
    expect(out.find((o) => o.org_id === quiet.orgId)).toBeUndefined(); // low_balance disabled
    const tg = ctx.engine.telegram.filter((t) => t.body.chat_id === '987654');
    expect(tg).toHaveLength(1);
    expect(tg[0].token).toBe('123456:test-token');
    expect(tg[0].body.text).toMatch(/Low balance/);
    expect(tg[0].body.text).toMatch(/0\.000000 USD available \(alert threshold 1\.000000 USD\)/);
    const mail = mails.find((m) => m.to === client.email);
    expect(mail?.subject).toMatch(/Low balance/);

    expect((await worker.lowBalance()).find((o) => o.org_id === client.orgId)).toBeUndefined();
    expect(ctx.engine.telegram.filter((t) => t.body.chat_id === '987654')).toHaveLength(1);
    const ttl = await redis.client.ttl(`alert:low_balance:${client.orgId}`);
    expect(ttl).toBeGreaterThan(6 * 3600 - 60);
    expect(ttl).toBeLessThanOrEqual(6 * 3600);
  });

  it('uses the live engine balance when available and email_to when configured', async () => {
    await redis.client.del(`alert:low_balance:${client.orgId}`);
    ctx.engine.balances.set(client.orgId, 5_000_000);
    expect((await worker.lowBalance()).find((o) => o.org_id === client.orgId)).toBeUndefined();
    ctx.engine.balances.set(client.orgId, 999_999);
    await as(ctx, client).put('/api/notifications/settings', { email_to: ['billing@example.com'], telegram_enabled: false }).expect(200);
    const out = await worker.lowBalance();
    expect(out.find((o) => o.org_id === client.orgId)?.channels).toEqual(['email']);
    expect(mails.find((m) => m.to === 'billing@example.com')?.text).toMatch(/0\.999999 USD available/);
    ctx.engine.balances.delete(client.orgId);
  });

  it('a failed delivery releases the dedupe claim so the next pass retries', async () => {
    await redis.client.del(`alert:low_balance:${client.orgId}`);
    const sender = ctx.app.get(AlertSender);
    const ok = sender.transporter;
    sender.transporter = { sendMail: async () => Promise.reject(new Error('smtp down')) } as never;
    expect((await worker.lowBalance()).find((o) => o.org_id === client.orgId)).toBeUndefined();
    expect(await redis.client.exists(`alert:low_balance:${client.orgId}`)).toBe(0);
    sender.transporter = ok;
    expect((await worker.lowBalance()).find((o) => o.org_id === client.orgId)?.channels).toEqual(['email']);
  });

  it('route down (admin): enabled route with no bound connection', async () => {
    await as(ctx, admin).put('/api/notifications/settings', { telegram_enabled: true, telegram_chat_id: '-100200300', email_enabled: false }).expect(200);
    const connA = randomUUID();
    const routeUp = randomUUID();
    const routeDown = randomUUID();
    await ctx.db
      .insertInto('upstream_connections')
      .values([
        { id: connA, name: uniq('al-conn-a'), host: 'smsc.example', port: 2775, system_id: 'a', password_enc: 'v1:x', max_tps: 10 },
      ])
      .execute();
    await ctx.db.insertInto('routes').values([{ id: routeUp, name: uniq('al-up') }, { id: routeDown, name: uniq('al-down') }]).execute();
    await ctx.db.insertInto('route_connections').values([{ route_id: routeUp, connection_id: connA }]).execute();
    ctx.engine.connections = [{ connection_id: connA, name: 'a', enabled: true, state: 'BOUND', sessions: [], tps_limit: 10, tps_current: 0, inflight: 0, queue_depth: 0, submitted_total: 0, failed_total: 0 }];

    const out = await worker.routeDown();
    expect(out.find((o) => o.subject_id === routeUp)).toBeUndefined();
    expect(out.find((o) => o.subject_id === routeDown)).toEqual({ kind: 'route_down', org_id: admin.orgId, subject_id: routeDown, channels: ['telegram'] });
    const tg = ctx.engine.telegram.filter((t) => t.body.chat_id === '-100200300');
    expect(tg.some((t) => /Route down/.test(t.body.text) && /no enabled upstream connection/.test(t.body.text))).toBe(true);
    expect((await worker.routeDown()).find((o) => o.subject_id === routeDown)).toBeUndefined(); // deduped

    (ctx.engine.connections[0] as { state: string }).state = 'DOWN';
    const down = await worker.routeDown();
    expect(down.find((o) => o.subject_id === routeUp)?.channels).toEqual(['telegram']);
    expect(ctx.engine.telegram.some((t) => /none of its 1 enabled connection\(s\) is bound/.test(t.body.text))).toBe(true);

    ctx.engine.down = true;
    await redis.client.del(`alert:route_down:${admin.orgId}:${routeUp}`);
    expect(await worker.routeDown()).toEqual([]); // engine unreachable: no guesswork
  });

  it('tick() runs both checks', async () => {
    await redis.client.del(`alert:low_balance:${client.orgId}`);
    const out = await worker.tick();
    expect(out.some((o) => o.kind === 'low_balance' && o.org_id === client.orgId)).toBe(true);
  });
});

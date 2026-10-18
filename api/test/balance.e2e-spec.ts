import { BalanceService } from '../src/balance/balance.service';
import { Session, TestCtx, adminLogin, as, createChild, setup, uniq, waitFor } from './helpers';

describe('balance (CONTRACTS §6 flow, mocked engine)', () => {
  let ctx: TestCtx;
  let admin: Session;
  let reseller: Session;
  let client: Session;

  beforeAll(async () => {
    ctx = await setup();
    admin = await adminLogin(ctx);
    reseller = await createChild(ctx, admin, uniq('bal-r'));
    client = await createChild(ctx, reseller, uniq('bal-c'));
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(() => ctx.engine.reset());

  const snapshot = async (orgId: string) =>
    (await ctx.db.selectFrom('accounts_balance').select('balance_micros').where('org_id', '=', orgId).executeTakeFirstOrThrow()).balance_micros;

  it('OK: ledger row first, engine credit with its idempotency key, applied_at set, snapshot untouched', async () => {
    ctx.engine.balances.set(client.orgId, 1_000_000);
    const res = await as(ctx, reseller).post(`/api/orgs/${client.orgId}/balance/topup`, { amount_micros: 5_000_000, note: 'invoice 42' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('OK');
    expect(res.body.transaction).toMatchObject({ type: 'TOPUP', amount_micros: 5_000_000, note: 'invoice 42', balance_after_micros: 6_000_000, created_by_user_id: reseller.userId });
    expect(res.body.transaction.applied_at).not.toBeNull();

    const calls = ctx.engine.calls('/internal/v1/balance/credit');
    expect(calls).toHaveLength(1);
    const row = await ctx.db.selectFrom('balance_transactions').selectAll().where('id', '=', res.body.transaction.id).executeTakeFirstOrThrow();
    expect(calls[0].body).toEqual({ org_id: client.orgId, delta_micros: 5_000_000, idempotency_key: row.idempotency_key });
    expect(row.applied_at).not.toBeNull();
    expect(await snapshot(client.orgId)).toBe(0); // engine's syncer owns it while loaded

    const bal = await as(ctx, client).get(`/api/orgs/${client.orgId}/balance`);
    expect(bal.body).toMatchObject({ balance_micros: 6_000_000, source: 'engine', billing_mode: 'PREPAID', currency: 'USD' });
    const audit = await ctx.db.selectFrom('audit_logs').selectAll().where('action', '=', 'balance.topup').where('target_org_id', '=', client.orgId).executeTakeFirstOrThrow();
    expect(audit.actor_user_id).toBe(reseller.userId);
    ctx.engine.balances.delete(client.orgId);
  });

  it('NOT_LOADED: also adds the delta to accounts_balance', async () => {
    ctx.engine.creditStatus = 'NOT_LOADED';
    const before = await snapshot(reseller.orgId);
    const res = await as(ctx, admin).post(`/api/orgs/${reseller.orgId}/balance/topup`, { amount_micros: 2_500_000 });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('NOT_LOADED');
    expect(res.body.transaction.balance_after_micros).toBe(before + 2_500_000);
    expect(await snapshot(reseller.orgId)).toBe(before + 2_500_000);
    const bal = await as(ctx, reseller).get(`/api/orgs/${reseller.orgId}/balance`);
    expect(bal.body).toMatchObject({ balance_micros: before + 2_500_000, source: 'database' });
  });

  it('adjust: signed, note required', async () => {
    ctx.engine.creditStatus = 'NOT_LOADED';
    expect((await as(ctx, reseller).post(`/api/orgs/${client.orgId}/balance/adjust`, { amount_micros: -100 })).status).toBe(400);
    expect((await as(ctx, reseller).post(`/api/orgs/${client.orgId}/balance/adjust`, { amount_micros: 0, note: 'x' })).status).toBe(400);
    const before = await snapshot(client.orgId);
    const res = await as(ctx, reseller).post(`/api/orgs/${client.orgId}/balance/adjust`, { amount_micros: -300_000, note: 'chargeback' });
    expect(res.status).toBe(200);
    expect(res.body.transaction.type).toBe('ADJUSTMENT');
    expect(await snapshot(client.orgId)).toBe(before - 300_000);
    expect((await as(ctx, reseller).post(`/api/orgs/${client.orgId}/balance/topup`, { amount_micros: -5 })).status).toBe(400);
  });

  it('idempotency key: a replay returns the same transaction and credits once', async () => {
    ctx.engine.creditStatus = 'NOT_LOADED';
    const before = await snapshot(client.orgId);
    const a = await as(ctx, reseller).post(`/api/orgs/${client.orgId}/balance/topup`, { amount_micros: 1_000 }).set('Idempotency-Key', 'pay-777');
    const b = await as(ctx, reseller).post(`/api/orgs/${client.orgId}/balance/topup`, { amount_micros: 1_000 }).set('Idempotency-Key', 'pay-777');
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body.transaction.id).toBe(a.body.transaction.id);
    expect(b.body.replay).toBe(true);
    expect(await snapshot(client.orgId)).toBe(before + 1_000);
    const mismatch = await as(ctx, reseller).post(`/api/orgs/${client.orgId}/balance/topup`, { amount_micros: 2_000, idempotency_key: 'pay-777' });
    expect(mismatch.status).toBe(409);
  });

  it('engine down: transaction recorded unapplied (502); the reconciler applies it later with the same key', async () => {
    ctx.engine.down = true;
    const res = await as(ctx, reseller).post(`/api/orgs/${client.orgId}/balance/topup`, { amount_micros: 42 });
    expect(res.status).toBe(502);
    expect(res.body.error_code).toBe('INTERNAL');
    const txId = res.body.details.transaction_id;
    const row = await ctx.db.selectFrom('balance_transactions').selectAll().where('id', '=', txId).executeTakeFirstOrThrow();
    expect(row.applied_at).toBeNull();

    ctx.engine.down = false;
    ctx.engine.reset();
    ctx.engine.balances.set(client.orgId, 100);
    const applied = await ctx.app.get(BalanceService).reconcileOnce(0);
    expect(applied).toBeGreaterThanOrEqual(1);
    const credit = ctx.engine.calls('/internal/v1/balance/credit').find((c) => (c.body as { idempotency_key: string }).idempotency_key === row.idempotency_key);
    expect(credit).toBeDefined();
    const after = await ctx.db.selectFrom('balance_transactions').select(['applied_at', 'balance_after_micros']).where('id', '=', txId).executeTakeFirstOrThrow();
    expect(after.applied_at).not.toBeNull();
    expect(after.balance_after_micros).toBe(142);
    expect(await ctx.app.get(BalanceService).reconcileOnce(0)).toBe(0); // nothing left
    ctx.engine.balances.delete(client.orgId);
  });

  it('only the parent may credit; clients cannot top themselves up', async () => {
    expect((await as(ctx, client).post(`/api/orgs/${client.orgId}/balance/topup`, { amount_micros: 1 })).status).toBe(403);
    expect((await as(ctx, admin).post(`/api/orgs/${client.orgId}/balance/topup`, { amount_micros: 1 })).status).toBe(403);
    expect((await as(ctx, reseller).post(`/api/orgs/${reseller.orgId}/balance/topup`, { amount_micros: 1 })).status).toBe(403);
    expect((await as(ctx, admin).get(`/api/orgs/${admin.orgId}/balance`)).status).toBe(404);
  });

  it('billing: POSTPAID with credit limit; PREPAID forces limit 0; invalidates accounts_balance', async () => {
    const p = await as(ctx, reseller).patch(`/api/orgs/${client.orgId}/billing`, { billing_mode: 'POSTPAID', credit_limit_micros: 9_000_000, low_balance_alert_micros: 100 });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ billing_mode: 'POSTPAID', credit_limit_micros: 9_000_000, low_balance_alert_micros: 100 });
    expect((await as(ctx, reseller).patch(`/api/orgs/${client.orgId}/billing`, { billing_mode: 'PREPAID', credit_limit_micros: 5 })).status).toBe(400);
    const back = await as(ctx, reseller).patch(`/api/orgs/${client.orgId}/billing`, { billing_mode: 'PREPAID' });
    expect(back.body.credit_limit_micros).toBe(0);
    expect((await as(ctx, client).patch(`/api/orgs/${client.orgId}/billing`, { billing_mode: 'POSTPAID' })).status).toBe(403);
    await waitFor(() => ctx.invalidations.some((m) => m.entity === 'accounts_balance' && m.id === client.orgId));
  });

  it('transactions list is paginated and newest first', async () => {
    const r = await as(ctx, client).get(`/api/orgs/${client.orgId}/transactions?page_size=2`);
    expect(r.status).toBe(200);
    expect(r.body.page_size).toBe(2);
    expect(r.body.items).toHaveLength(2);
    expect(r.body.total).toBeGreaterThanOrEqual(4);
    expect(new Date(r.body.items[0].created_at).getTime()).toBeGreaterThanOrEqual(new Date(r.body.items[1].created_at).getTime());
    expect(r.body.items[0].idempotency_key).toBeUndefined();
    const adj = await as(ctx, reseller).get(`/api/orgs/${client.orgId}/transactions?type=ADJUSTMENT`);
    expect(adj.body.items.every((t: { type: string }) => t.type === 'ADJUSTMENT')).toBe(true);
  });
});

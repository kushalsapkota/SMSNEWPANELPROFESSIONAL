import { Session, TestCtx, adminLogin, as, createChild, setup, uniq } from './helpers';

/**
 * SMPP account credential reveal (migration 008): the org itself, its parent reseller and the
 * admin can read back the bind password to copy the full connection. Unrelated tenants cannot,
 * every reveal is audited, and the plaintext never lands in an audit row.
 */
describe('smpp account credentials reveal', () => {
  let ctx: TestCtx;
  let admin: Session;
  let reseller: Session;
  let client: Session;
  let otherReseller: Session;
  let otherClient: Session;

  const systemId = uniq('sys').replace(/[^A-Za-z0-9]/g, '').slice(-15);
  let accountId: string;

  beforeAll(async () => {
    ctx = await setup();
    admin = await adminLogin(ctx);
    reseller = await createChild(ctx, admin, uniq('cred-r'));
    client = await createChild(ctx, reseller, uniq('cred-c'));
    otherReseller = await createChild(ctx, admin, uniq('cred-r2'));
    otherClient = await createChild(ctx, otherReseller, uniq('cred-c2'));

    const res = await as(ctx, client).post('/api/smpp-accounts', { system_id: systemId, password: 'abc12345' });
    expect(res.status).toBe(201);
    accountId = res.body.id;
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('returns the password to the org, its parent reseller and the admin', async () => {
    for (const who of [client, reseller, admin]) {
      const r = await as(ctx, who).get(`/api/smpp-accounts/${accountId}/credentials`);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ system_id: systemId, password: 'abc12345', password_available: true });
      expect(r.body.password_hash).toBeUndefined();
      expect(r.body.password_enc).toBeUndefined();
    }
  });

  it('hides it from unrelated tenants', async () => {
    for (const who of [otherReseller, otherClient]) {
      const r = await as(ctx, who).get(`/api/smpp-accounts/${accountId}/credentials`);
      expect([403, 404]).toContain(r.status);
    }
  });

  it('reflects a rotated password', async () => {
    expect((await as(ctx, client).post(`/api/smpp-accounts/${accountId}/password`, { password: 'newpass1' })).status).toBe(200);
    const r = await as(ctx, client).get(`/api/smpp-accounts/${accountId}/credentials`);
    expect(r.body).toMatchObject({ password: 'newpass1', password_available: true });
  });

  it('audits each reveal without ever storing the plaintext', async () => {
    const audits = await ctx.db
      .selectFrom('audit_logs')
      .select(['action', 'before', 'after'])
      .where('entity_id', '=', accountId)
      .execute();
    expect(audits.some((a) => a.action === 'smpp_account.credentials_view')).toBe(true);
    expect(JSON.stringify(audits)).not.toMatch(/abc12345|newpass1/);
  });
});

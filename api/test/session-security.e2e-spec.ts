import jwt from 'jsonwebtoken';
import { Session, TestCtx, adminLogin, as, createChild, setup, uniq } from './helpers';

/**
 * Panel sessions are re-validated on every request and on refresh (review findings):
 *  - the user's REAL org must be active, also while impersonating (a suspended reseller keeps no
 *    access to its clients through an impersonation token or its refresh token);
 *  - the PANEL/ALL IP whitelist of the real org applies to refresh and to every request, not only
 *    to login;
 *  - the admin may impersonate resellers only.
 * TRUST_PROXY=1 with the default trusted set (loopback): the test client sets X-Forwarded-For.
 */
describe('session security', () => {
  let ctx: TestCtx;
  let admin: Session;

  beforeAll(async () => {
    ctx = await setup({ env: () => ({ TRUST_PROXY: '1', TRUSTED_PROXIES: '' }) });
    admin = await adminLogin(ctx);
  });
  afterAll(async () => {
    await ctx.close();
  });

  const from = (ip: string, s: Session) => ({
    get: (url: string) => as(ctx, s).get(url).set('X-Forwarded-For', ip),
    post: (url: string, body?: unknown) => as(ctx, s).post(url, body).set('X-Forwarded-For', ip),
  });
  const refreshFrom = (ip: string, token: string) => ctx.http().post('/api/auth/refresh').set('X-Forwarded-For', ip).send({ refresh_token: token });
  const withTokens = (s: Session, body: { access_token: string; refresh_token: string }): Session => ({ ...s, token: body.access_token, refresh: body.refresh_token });

  describe('impersonation and the real org state', () => {
    it('a suspended reseller loses its impersonation sessions (access token, refresh token, nested impersonation)', async () => {
      const r1 = await createChild(ctx, admin, uniq('ss-r1'));
      const c1 = await createChild(ctx, r1, uniq('ss-c1'));
      const c2 = await createChild(ctx, r1, uniq('ss-c2'));
      const imp = await as(ctx, r1).post('/api/auth/impersonate', { org_id: c1.orgId });
      expect(imp.status).toBe(200);
      const asC1 = withTokens(r1, imp.body);
      expect((await as(ctx, asC1).get('/api/api-keys')).status).toBe(200);

      await as(ctx, admin).post(`/api/orgs/${r1.orgId}/suspend`, { reason: 'unpaid' }).expect(200);

      const keys = await as(ctx, asC1).get('/api/api-keys');
      expect(keys.status).toBe(403);
      expect(keys.body.error_code).toBe('ACCOUNT_SUSPENDED');
      expect((await as(ctx, asC1).post('/api/api-keys', { name: 'backdoor' })).status).toBe(403);
      expect((await as(ctx, asC1).post('/api/auth/impersonate', { org_id: c2.orgId })).status).toBe(403);
      // Suspending revokes the reseller users' impersonation refresh tokens.
      expect((await ctx.http().post('/api/auth/refresh').send({ refresh_token: asC1.refresh })).status).toBe(401);
      const live = await ctx.db
        .selectFrom('refresh_tokens')
        .select('id')
        .where('user_id', '=', r1.userId)
        .where('impersonated_org_id', 'is not', null)
        .where('revoked_at', 'is', null)
        .execute();
      expect(live).toHaveLength(0);
    });

    it('refresh re-checks the real org even when the token was not revoked', async () => {
      const r1 = await createChild(ctx, admin, uniq('ss-r2'));
      const c1 = await createChild(ctx, r1, uniq('ss-c3'));
      const imp = await as(ctx, r1).post('/api/auth/impersonate', { org_id: c1.orgId });
      // Suspended behind the api's back (no revocation): the checks alone must hold.
      await ctx.db.updateTable('organizations').set({ status: 'SUSPENDED' }).where('id', '=', r1.orgId).execute();
      try {
        const ref = await ctx.http().post('/api/auth/refresh').send({ refresh_token: imp.body.refresh_token });
        expect(ref.status).toBe(403);
        expect(ref.body.error_code).toBe('ACCOUNT_SUSPENDED');
        expect((await as(ctx, withTokens(r1, imp.body)).get('/api/auth/me')).status).toBe(403);
        // and a suspended org cannot start a new impersonation either
        expect((await as(ctx, r1).post('/api/auth/impersonate', { org_id: c1.orgId })).status).toBe(403);
      } finally {
        await ctx.db.updateTable('organizations').set({ status: 'ACTIVE' }).where('id', '=', r1.orgId).execute();
      }
      // reactivated: the same impersonation refresh token works again
      expect((await ctx.http().post('/api/auth/refresh').send({ refresh_token: imp.body.refresh_token })).status).toBe(200);
    });

    it('the admin impersonates resellers only; a client is reached through its reseller', async () => {
      const r = await createChild(ctx, admin, uniq('ss-r3'));
      const c = await createChild(ctx, r, uniq('ss-c4'));
      const direct = await as(ctx, admin).post('/api/auth/impersonate', { org_id: c.orgId });
      expect(direct.status).toBe(403);
      const asR = await as(ctx, admin).post('/api/auth/impersonate', { org_id: r.orgId });
      expect(asR.status).toBe(200);
      // nested: still decided on the real (admin) org
      expect((await as(ctx, withTokens(admin, asR.body)).post('/api/auth/impersonate', { org_id: c.orgId })).status).toBe(403);
      // a forged admin->client token (valid signature) is refused by the guard
      const forged = jwt.sign({ org: c.orgId, role: 'CLIENT', imp: admin.userId, oid: admin.orgId }, process.env.JWT_SECRET as string, {
        subject: admin.userId,
        issuer: 'smsgw-api',
        audience: 'smsgw',
        expiresIn: 60,
      });
      expect((await as(ctx, { ...admin, token: forged }).get('/api/auth/me')).status).toBe(401);
    });
  });

  describe('PANEL IP whitelist on every request and on refresh', () => {
    it('an existing session stops working from outside a newly added whitelist; refresh revokes it', async () => {
      const r = await createChild(ctx, admin, uniq('ss-ipr'));
      const c = await createChild(ctx, r, uniq('ss-ipc'));
      const res = await ctx.http().post('/api/auth/login').set('X-Forwarded-For', '203.0.113.9').send({ email: c.email, password: c.password });
      expect(res.status).toBe(200);
      const old = withTokens(c, res.body);
      expect((await from('203.0.113.9', old).get('/api/auth/me')).status).toBe(200);

      // The reseller restricts its client's panel to 10.0.0.0/8.
      await as(ctx, r).post('/api/ip-whitelist?org_id=' + c.orgId, { cidr: '10.0.0.0/8', scope: 'PANEL' }).expect(201);

      const me = await from('203.0.113.9', old).get('/api/auth/me');
      expect(me.status).toBe(403);
      expect(me.body.error_code).toBe('IP_NOT_ALLOWED');
      const send = await from('203.0.113.9', old).post('/api/messages/send', { to: '919876543210', from: 'ACME', text: 'hi' });
      expect(send.status).toBe(403);
      expect(send.body.error_code).toBe('IP_NOT_ALLOWED');

      const ref = await refreshFrom('203.0.113.9', old.refresh);
      expect(ref.status).toBe(403);
      expect(ref.body.error_code).toBe('IP_NOT_ALLOWED');
      // the refused refresh revoked the family: useless even from an allowed address now
      expect((await refreshFrom('10.1.2.3', old.refresh)).status).toBe(401);

      // From inside the whitelist everything works.
      const inside = await ctx.http().post('/api/auth/login').set('X-Forwarded-For', '10.1.2.3').send({ email: c.email, password: c.password });
      expect(inside.status).toBe(200);
      const s = withTokens(c, inside.body);
      expect((await from('10.1.2.3', s).get('/api/auth/me')).status).toBe(200);
      const ok = await refreshFrom('10.1.2.3', s.refresh);
      expect(ok.status).toBe(200);
      // the same access token is refused from elsewhere
      expect((await from('8.8.8.8', withTokens(c, ok.body)).get('/api/auth/me')).status).toBe(403);
    });

    it("impersonation is checked against the impersonator's (real org's) whitelist, not the client's", async () => {
      const r = await createChild(ctx, admin, uniq('ss-ipr2'));
      const c = await createChild(ctx, r, uniq('ss-ipc2'));
      await as(ctx, r).post('/api/ip-whitelist?org_id=' + c.orgId, { cidr: '10.0.0.0/8', scope: 'PANEL' }).expect(201);
      const imp = await from('198.51.100.20', r).post('/api/auth/impersonate', { org_id: c.orgId });
      expect(imp.status).toBe(200);
      const asC = withTokens(r, imp.body);
      expect((await from('198.51.100.20', asC).get('/api/api-keys')).status).toBe(200);

      // The reseller restricts its own panel; its impersonation session follows that rule.
      await from('198.51.100.20', r).post('/api/ip-whitelist', { cidr: '198.51.100.0/24', scope: 'ALL' }).expect(201);
      expect((await from('198.51.100.20', asC).get('/api/api-keys')).status).toBe(200);
      const outside = await from('8.8.8.8', asC).get('/api/api-keys');
      expect(outside.status).toBe(403);
      expect(outside.body.error_code).toBe('IP_NOT_ALLOWED');
      expect((await refreshFrom('8.8.8.8', asC.refresh)).status).toBe(403);
    });
  });
});

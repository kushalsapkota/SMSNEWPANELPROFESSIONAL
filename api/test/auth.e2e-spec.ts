import jwt from 'jsonwebtoken';
import { ADMIN_EMAIL, ADMIN_PASSWORD, TestCtx, adminLogin, as, createChild, login, setup, totpNow, uniq } from './helpers';

describe('auth', () => {
  let ctx: TestCtx;

  beforeAll(async () => {
    ctx = await setup();
  });
  afterAll(async () => {
    await ctx.close();
  });

  describe('login', () => {
    it('logs in the seeded admin and returns tokens, user and org', async () => {
      const res = await ctx.http().post('/api/auth/login').send({ email: ADMIN_EMAIL.toUpperCase(), password: ADMIN_PASSWORD });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ token_type: 'Bearer', expires_in: 900, user: { email: ADMIN_EMAIL }, org: { role: 'SUPER_ADMIN' } });
      expect(res.body.user.password_hash).toBeUndefined();
      const claims = jwt.decode(res.body.access_token) as jwt.JwtPayload;
      expect(claims).toMatchObject({ sub: res.body.user.id, org: res.body.org.id, role: 'SUPER_ADMIN' });
      expect(claims.exp! - claims.iat!).toBe(900);
      expect(claims.imp).toBeUndefined();
    });

    it('rejects a wrong password / unknown email with 401 UNAUTHORIZED', async () => {
      const a = await ctx.http().post('/api/auth/login').send({ email: 'nobody@test.local', password: 'whatever-123' });
      expect(a.status).toBe(401);
      expect(a.body.error_code).toBe('UNAUTHORIZED');
      const v = await ctx.http().post('/api/auth/login').send({ email: 'not-an-email', password: '' });
      expect(v.status).toBe(400);
      expect(v.body.error_code).toBe('INVALID_REQUEST');
      expect(v.body.details.issues.length).toBeGreaterThan(0);
    });

    it('locks the account for 15 minutes after 5 failures, even for the right password', async () => {
      const admin = await adminLogin(ctx);
      const child = await createChild(ctx, admin, uniq('lockout'));
      for (let i = 0; i < 4; i++) {
        const r = await ctx.http().post('/api/auth/login').send({ email: child.email, password: 'wrong-password' });
        expect(r.status).toBe(401);
      }
      const fifth = await ctx.http().post('/api/auth/login').send({ email: child.email, password: 'wrong-password' });
      expect(fifth.status).toBe(401);
      expect(fifth.body.details.locked_until).toBeDefined();
      const lockedUntil = new Date(fifth.body.details.locked_until).getTime();
      expect(lockedUntil - Date.now()).toBeGreaterThan(14 * 60_000);
      expect(lockedUntil - Date.now()).toBeLessThanOrEqual(15 * 60_000 + 5000);

      const right = await ctx.http().post('/api/auth/login').send({ email: child.email, password: child.password });
      expect(right.status).toBe(401);
      expect(right.body.message).toMatch(/locked/i);

      const audit = await ctx.db.selectFrom('audit_logs').selectAll().where('action', '=', 'auth.lockout').where('entity_id', '=', child.userId).execute();
      expect(audit).toHaveLength(1);

      // Lock expiry restores access.
      await ctx.db.updateTable('users').set({ locked_until: new Date(Date.now() - 1000) }).where('id', '=', child.userId).execute();
      await login(ctx, child.email, child.password);
    });

    it('requires a Bearer token on protected endpoints', async () => {
      const r = await ctx.http().get('/api/auth/me');
      expect(r.status).toBe(401);
      expect(r.body).toEqual({ error_code: 'UNAUTHORIZED', message: expect.any(String) });
      const bad = await ctx.http().get('/api/auth/me').set('Authorization', 'Bearer not.a.jwt');
      expect(bad.status).toBe(401);
      const forged = jwt.sign({ org: 'x', role: 'SUPER_ADMIN' }, 'wrong-secret-wrong-secret-wrong-secret', { subject: 'x' });
      expect((await ctx.http().get('/api/auth/me').set('Authorization', `Bearer ${forged}`)).status).toBe(401);
    });
  });

  describe('refresh rotation', () => {
    it('rotates refresh tokens and revokes the whole family on reuse', async () => {
      const s = await adminLogin(ctx);
      const r1 = await ctx.http().post('/api/auth/refresh').send({ refresh_token: s.refresh });
      expect(r1.status).toBe(200);
      expect(r1.body.refresh_token).not.toBe(s.refresh);
      expect(r1.body.access_token).toBeDefined();

      const r2 = await ctx.http().post('/api/auth/refresh').send({ refresh_token: r1.body.refresh_token });
      expect(r2.status).toBe(200);

      // Replaying the first (already rotated) token = theft signal.
      const reuse = await ctx.http().post('/api/auth/refresh').send({ refresh_token: s.refresh });
      expect(reuse.status).toBe(401);
      expect(reuse.body.message).toMatch(/reuse/i);

      // ...which also kills the newest legitimate token of that family.
      const after = await ctx.http().post('/api/auth/refresh').send({ refresh_token: r2.body.refresh_token });
      expect(after.status).toBe(401);

      const fam = await ctx.db.selectFrom('refresh_tokens').select(['family_id', 'revoked_at', 'revoked_reason']).where('user_id', '=', s.userId).execute();
      const famId = fam.find((f) => f.revoked_reason === 'reuse_detected')?.family_id;
      expect(famId).toBeDefined();
      expect(fam.filter((f) => f.family_id === famId).every((f) => f.revoked_at !== null)).toBe(true);
      const audit = await ctx.db.selectFrom('audit_logs').select('id').where('action', '=', 'auth.refresh_reuse_detected').where('entity_id', '=', famId!).execute();
      // both the replayed token and the (now revoked) newest token were flagged
      expect(audit).toHaveLength(2);
    });

    it('logout revokes the refresh token family', async () => {
      const s = await adminLogin(ctx);
      const out = await ctx.http().post('/api/auth/logout').send({ refresh_token: s.refresh });
      expect(out.status).toBe(200);
      const r = await ctx.http().post('/api/auth/refresh').send({ refresh_token: s.refresh });
      expect(r.status).toBe(401);
    });

    it('rejects expired refresh tokens', async () => {
      const s = await adminLogin(ctx);
      await ctx.db.updateTable('refresh_tokens').set({ expires_at: new Date(Date.now() - 1000) }).where('user_id', '=', s.userId).where('revoked_at', 'is', null).execute();
      const r = await ctx.http().post('/api/auth/refresh').send({ refresh_token: s.refresh });
      expect(r.status).toBe(401);
      expect(r.body.message).toMatch(/expired/i);
    });
  });

  describe('me & password', () => {
    it('returns the acting user and org', async () => {
      const s = await adminLogin(ctx);
      const me = await as(ctx, s).get('/api/auth/me');
      expect(me.status).toBe(200);
      expect(me.body).toMatchObject({ user: { id: s.userId }, org: { id: s.orgId, role: 'SUPER_ADMIN' }, impersonating: false });
      expect(me.body.original_org).toBeUndefined();
    });

    it('changes the password, returns a new session and invalidates the old ones', async () => {
      const admin = await adminLogin(ctx);
      const child = await createChild(ctx, admin, uniq('pw'));
      const bad = await as(ctx, child).post('/api/auth/password', { current_password: 'nope-nope', new_password: 'Another-Passw0rd' });
      expect(bad.status).toBe(400);
      const weak = await as(ctx, child).post('/api/auth/password', { current_password: child.password, new_password: 'short' });
      expect(weak.status).toBe(400);

      await new Promise((r) => setTimeout(r, 1100)); // iat granularity is 1s
      const ok = await as(ctx, child).post('/api/auth/password', { current_password: child.password, new_password: 'Another-Passw0rd' });
      expect(ok.status).toBe(200);
      expect(ok.body.access_token).toBeDefined();

      expect((await as(ctx, child).get('/api/auth/me')).status).toBe(401); // old access token
      expect((await ctx.http().post('/api/auth/refresh').send({ refresh_token: child.refresh })).status).toBe(401);
      expect((await as(ctx, { ...child, token: ok.body.access_token }).get('/api/auth/me')).status).toBe(200);
      await login(ctx, child.email, 'Another-Passw0rd');
    });
  });

  describe('TOTP 2FA', () => {
    it('setup -> enable -> login requires code -> recovery code works once -> disable', async () => {
      const admin = await adminLogin(ctx);
      const u = await createChild(ctx, admin, uniq('totp'));

      const setupRes = await as(ctx, u).post('/api/auth/totp/setup');
      expect(setupRes.status).toBe(200);
      const secret: string = setupRes.body.secret;
      expect(setupRes.body.otpauth_url).toMatch(/^otpauth:\/\/totp\//);
      const stored = await ctx.db.selectFrom('users').select(['totp_secret_enc', 'totp_enabled']).where('id', '=', u.userId).executeTakeFirstOrThrow();
      expect(stored.totp_enabled).toBe(false);
      expect(stored.totp_secret_enc!.toString('utf8')).toMatch(/^v1:/);
      expect(stored.totp_secret_enc!.toString('utf8')).not.toContain(secret);

      expect((await as(ctx, u).post('/api/auth/totp/enable', { code: '000000' })).status).toBe(400);
      const en = await as(ctx, u).post('/api/auth/totp/enable', { code: totpNow(secret) });
      expect(en.status).toBe(200);
      expect(en.body.recovery_codes).toHaveLength(10);
      expect(new Set(en.body.recovery_codes).size).toBe(10);
      const hashes = await ctx.db.selectFrom('users').select('totp_recovery_hashes').where('id', '=', u.userId).executeTakeFirstOrThrow();
      expect(hashes.totp_recovery_hashes).toHaveLength(10);
      expect(hashes.totp_recovery_hashes).not.toContain(en.body.recovery_codes[0]);

      const noCode = await ctx.http().post('/api/auth/login').send({ email: u.email, password: u.password });
      expect(noCode.status).toBe(200);
      expect(noCode.body).toEqual({ requires_totp: true });

      const wrong = await ctx.http().post('/api/auth/login').send({ email: u.email, password: u.password, totp_code: '123456' });
      expect(wrong.status).toBe(401);

      const withCode = await login(ctx, u.email, u.password, totpNow(secret));
      expect(withCode.token).toBeDefined();

      const rc = en.body.recovery_codes[0];
      await login(ctx, u.email, u.password, rc);
      const again = await ctx.http().post('/api/auth/login').send({ email: u.email, password: u.password, totp_code: rc });
      expect(again.status).toBe(401);

      const dis = await as(ctx, withCode).post('/api/auth/totp/disable', { code: totpNow(secret) });
      expect(dis.status).toBe(200);
      await login(ctx, u.email, u.password);
    });
  });

  describe('impersonation', () => {
    it('admin -> reseller -> stop; claims carry imp/oid; audited', async () => {
      const admin = await adminLogin(ctx);
      const reseller = await createChild(ctx, admin, uniq('imp-r'));
      const imp = await as(ctx, admin).post('/api/auth/impersonate', { org_id: reseller.orgId });
      expect(imp.status).toBe(200);
      const claims = jwt.decode(imp.body.access_token) as jwt.JwtPayload;
      expect(claims).toMatchObject({ sub: admin.userId, org: reseller.orgId, role: 'RESELLER', imp: admin.userId, oid: admin.orgId });

      const impS = { ...admin, token: imp.body.access_token, refresh: imp.body.refresh_token };
      const me = await as(ctx, impS).get('/api/auth/me');
      expect(me.body).toMatchObject({ impersonating: true, org: { id: reseller.orgId }, original_org: { id: admin.orgId } });

      // Acting as the reseller: can create a client (the admin path to clients).
      const client = await as(ctx, impS).post('/api/orgs', { name: uniq('imp-c'), email: `${uniq('impc')}@test.local`, password: 'Client-Passw0rd' });
      expect(client.status).toBe(201);
      expect(client.body.role).toBe('CLIENT');
      expect(client.body.parent_id).toBe(reseller.orgId);
      const createdAudit = await ctx.db.selectFrom('audit_logs').selectAll().where('entity_id', '=', client.body.id).where('action', '=', 'client.create').executeTakeFirstOrThrow();
      expect(createdAudit).toMatchObject({ actor_user_id: admin.userId, actor_org_id: reseller.orgId, impersonator_user_id: admin.userId });

      // Refreshing an impersonation session keeps impersonating.
      const ref = await ctx.http().post('/api/auth/refresh').send({ refresh_token: imp.body.refresh_token });
      expect((jwt.decode(ref.body.access_token) as jwt.JwtPayload).org).toBe(reseller.orgId);

      // Not allowed to change the 2FA of the real user while impersonating.
      expect((await as(ctx, impS).post('/api/auth/totp/setup')).status).toBe(403);

      const stop = await as(ctx, impS).post('/api/auth/impersonate/stop');
      expect(stop.status).toBe(200);
      const back = jwt.decode(stop.body.access_token) as jwt.JwtPayload;
      expect(back).toMatchObject({ sub: admin.userId, org: admin.orgId, role: 'SUPER_ADMIN' });
      expect(back.imp).toBeUndefined();
      // impersonation refresh tokens are revoked on stop
      expect((await ctx.http().post('/api/auth/refresh').send({ refresh_token: ref.body.refresh_token })).status).toBe(401);

      const audits = await ctx.db.selectFrom('audit_logs').select('action').where('target_org_id', '=', reseller.orgId).where('action', 'like', 'auth.impersonate%').execute();
      expect(audits.map((a) => a.action).sort()).toEqual(['auth.impersonate', 'auth.impersonate_stop']);
    });

    it('admin may impersonate a client directly; reseller only its own clients; clients nobody', async () => {
      const admin = await adminLogin(ctx);
      const r1 = await createChild(ctx, admin, uniq('imp-r1'));
      const r2 = await createChild(ctx, admin, uniq('imp-r2'));
      const c1 = await createChild(ctx, r1, uniq('imp-c1'));
      const c2 = await createChild(ctx, r2, uniq('imp-c2'));

      expect((await as(ctx, admin).post('/api/auth/impersonate', { org_id: c1.orgId })).status).toBe(200);
      expect((await as(ctx, r1).post('/api/auth/impersonate', { org_id: c1.orgId })).status).toBe(200);
      const foreign = await as(ctx, r1).post('/api/auth/impersonate', { org_id: c2.orgId });
      expect(foreign.status).toBe(403);
      expect((await as(ctx, r1).post('/api/auth/impersonate', { org_id: r2.orgId })).status).toBe(403);
      expect((await as(ctx, r1).post('/api/auth/impersonate', { org_id: admin.orgId })).status).toBe(403);
      expect((await as(ctx, c1).post('/api/auth/impersonate', { org_id: c2.orgId })).status).toBe(403);
      expect((await as(ctx, c1).post('/api/auth/impersonate/stop')).status).toBe(400);
    });
  });
});

import { Session, TestCtx, adminLogin, as, createChild, setup, uniq } from './helpers';

/**
 * Deleting orgs and users. DELETE /api/orgs/:id closes by default (reversible via activate) and
 * hard-deletes with ?purge=true, but only once the org is closed/suspended and has no sub-orgs.
 * DELETE /api/orgs/:id/users/:uid removes a user, never yourself and never the last one.
 */
describe('org + user deletion', () => {
  let ctx: TestCtx;
  let admin: Session;

  beforeAll(async () => {
    ctx = await setup();
    admin = await adminLogin(ctx);
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('closes a client (reversible), blocking login until re-opened', async () => {
    const reseller = await createChild(ctx, admin, uniq('del-r'));
    const client = await createChild(ctx, reseller, uniq('del-c'));

    const close = await as(ctx, reseller).delete(`/api/orgs/${client.orgId}`);
    expect(close.status).toBe(200);
    expect(close.body).toMatchObject({ status: 'CLOSED', sending_enabled: false, api_enabled: false, smpp_enabled: false });

    // The client's existing sessions are revoked, and it can no longer log in.
    const relogin = await ctx.http().post('/api/auth/login').send({ email: client.email, password: client.password });
    expect(relogin.status).toBeGreaterThanOrEqual(400);

    // Activate re-opens it; a fresh login then succeeds.
    expect((await as(ctx, reseller).post(`/api/orgs/${client.orgId}/activate`)).status).toBe(200);
    const ok = await ctx.http().post('/api/auth/login').send({ email: client.email, password: client.password });
    expect(ok.status).toBe(200);
  });

  it('refuses to purge an active org, and purges once closed', async () => {
    const reseller = await createChild(ctx, admin, uniq('del-r'));
    const client = await createChild(ctx, reseller, uniq('del-c'));

    // Active → must be closed first.
    expect((await as(ctx, reseller).delete(`/api/orgs/${client.orgId}?purge=true`)).status).toBe(400);

    expect((await as(ctx, reseller).delete(`/api/orgs/${client.orgId}`)).status).toBe(200);
    const purged = await as(ctx, reseller).delete(`/api/orgs/${client.orgId}?purge=true`);
    expect(purged.status).toBe(200);
    expect(purged.body).toMatchObject({ deleted: true });

    // Gone for good.
    expect((await as(ctx, reseller).get(`/api/orgs/${client.orgId}`)).status).toBe(404);
  });

  it('refuses to purge a reseller that still has clients', async () => {
    const reseller = await createChild(ctx, admin, uniq('del-r'));
    await createChild(ctx, reseller, uniq('del-c'));
    expect((await as(ctx, admin).delete(`/api/orgs/${reseller.orgId}`)).status).toBe(200); // close ok
    const purge = await as(ctx, admin).delete(`/api/orgs/${reseller.orgId}?purge=true`);
    expect(purge.status).toBe(400);
  });

  it('hides unrelated orgs from deletion (404/403)', async () => {
    const r1 = await createChild(ctx, admin, uniq('del-r1'));
    const c1 = await createChild(ctx, r1, uniq('del-c1'));
    const r2 = await createChild(ctx, admin, uniq('del-r2'));
    // r2 may not touch r1's client, nor may a client delete anything.
    expect([403, 404]).toContain((await as(ctx, r2).delete(`/api/orgs/${c1.orgId}`)).status);
    expect([403, 404]).toContain((await as(ctx, c1).delete(`/api/orgs/${r1.orgId}`)).status);
  });

  describe('users', () => {
    it('deletes an extra user but never yourself or the last one', async () => {
      const reseller = await createChild(ctx, admin, uniq('del-r'));
      const client = await createChild(ctx, reseller, uniq('del-c'));

      // The owner is the org's only user: cannot be deleted.
      expect((await as(ctx, reseller).delete(`/api/orgs/${client.orgId}/users/${client.userId}`)).status).toBe(400);

      // Add a second user, then the parent can delete it.
      const made = await as(ctx, reseller).post(`/api/orgs/${client.orgId}/users`, {
        email: `${uniq('u')}@test.local`,
        password: 'Child-Passw0rd!',
      });
      expect(made.status).toBe(201);
      const extraId = made.body.id as string;
      const del = await as(ctx, reseller).delete(`/api/orgs/${client.orgId}/users/${extraId}`);
      expect(del.status).toBe(200);
      expect(del.body).toMatchObject({ deleted: true });

      // A client cannot delete users in its own org (not the parent actor) → forbidden.
      expect([403, 404]).toContain((await as(ctx, client).delete(`/api/orgs/${client.orgId}/users/${client.userId}`)).status);
    });
  });
});

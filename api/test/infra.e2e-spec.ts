import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { sql } from 'kysely';
import { DbService } from '../src/db/db.service';
import { InvalidationService } from '../src/redis/redis.module';
import { seed } from '../src/seed';
import { ADMIN_EMAIL, TestCtx, adminLogin, setup, waitFor } from './helpers';

describe('infrastructure', () => {
  let ctx: TestCtx;
  beforeAll(async () => {
    ctx = await setup();
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('tenant transactions set app.org_id / app.role; after-commit hooks run only on commit', async () => {
    const db = ctx.app.get(DbService);
    const inv = ctx.app.get(InvalidationService);
    const admin = await adminLogin(ctx);
    const auth = { userId: admin.userId, orgId: admin.orgId, role: 'SUPER_ADMIN' as const };

    const settings = await db.runAs(auth, () =>
      db.tenant(async (trx) => {
        const r = await sql<{ org: string; role: string; user: string }>`select current_setting('app.org_id') as org, current_setting('app.role') as role, current_user as user`.execute(trx);
        return r.rows[0];
      }),
    );
    expect(settings).toEqual({ org: admin.orgId, role: 'SUPER_ADMIN', user: 'sms_api_login' });

    const marker = `rollback-${Date.now()}`;
    await expect(
      db.runAs(auth, () =>
        db.tenant(async () => {
          await inv.invalidate('routes', marker);
          throw new Error('boom');
        }),
      ),
    ).rejects.toThrow('boom');
    const committed = `commit-${Date.now()}`;
    await db.runAs(auth, () => db.tenant(() => inv.invalidate('routes', committed)));
    await waitFor(() => ctx.invalidations.some((m) => m.id === committed));
    expect(ctx.invalidations.some((m) => m.id === marker)).toBe(false);
    expect(ctx.invalidations.find((m) => m.id === committed)).toEqual({ entity: 'routes', id: committed });
  });

  it('seed is idempotent (function and npm script)', async () => {
    const a = await seed({ url: process.env.DATABASE_URL_PRIVILEGED as string, email: ADMIN_EMAIL, password: 'ignored-on-rerun', orgName: 'x' });
    expect(a.created).toBe(false);
    const out = execFileSync('npm', ['run', '-s', 'seed'], { cwd: path.resolve(__dirname, '..'), env: process.env, encoding: 'utf8' });
    expect(out).toMatch(/already present/);
    const admins = await ctx.db.selectFrom('organizations').select('id').where('role', '=', 'SUPER_ADMIN').execute();
    expect(admins).toHaveLength(1);
    await adminLogin(ctx); // password unchanged
  });
});

import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Kysely, PostgresDialect, Transaction, sql } from 'kysely';
import { Pool, types } from 'pg';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/config';
import { AfterCommitHook, AuthContext, RequestStore, currentStore, requestStore } from '../common/context';
import type { DB } from './types';

// int8 -> number (money is micros; |values| stay far below 2^53). count(*) too.
types.setTypeParser(types.builtins.INT8, (v) => Number(v));

export function createKysely(url: string, max: number, applicationName: string): Kysely<DB> {
  return new Kysely<DB>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: url, max, application_name: applicationName, idleTimeoutMillis: 30_000 }),
    }),
  });
}

/**
 * Two pools (CONTRACTS §1):
 *  - tenant     (DATABASE_URL, role sms_api, subject to RLS) — every request query.
 *  - privileged (DATABASE_URL_PRIVILEGED, role sms_engine, BYPASSRLS) — ONLY for auth flows,
 *    seeding, cross-tenant integrity lookups that RLS would hide (documented at each call site),
 *    and documented background jobs.
 */
@Injectable()
export class DbService implements OnModuleDestroy {
  private readonly logger = new Logger(DbService.name);
  readonly tenantDb: Kysely<DB>;
  readonly privileged: Kysely<DB>;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.tenantDb = createKysely(config.DATABASE_URL, config.DB_POOL_MAX, 'sms-api');
    this.privileged = createKysely(config.DATABASE_URL_PRIVILEGED, Math.max(2, Math.ceil(config.DB_POOL_MAX / 2)), 'sms-api-priv');
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([this.tenantDb.destroy(), this.privileged.destroy()]);
  }

  /**
   * Runs `fn` inside the current request's tenant transaction. The first call opens it
   * (`set_config('app.org_id'|'app.role', ..., true)`); nested calls reuse it. After the
   * outermost call commits, hooks registered with `afterCommit` run (rolled back = dropped).
   */
  async tenant<T>(fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
    const store = currentStore();
    const auth = store?.auth;
    if (!store || !auth) throw new Error('DbService.tenant() called outside an authenticated request context');
    if (store.tx) return fn(store.tx.trx);

    const hooks: AfterCommitHook[] = [];
    const result = await this.tenantDb.transaction().execute(async (trx) => {
      await sql`select set_config('app.org_id', ${auth.orgId}, true), set_config('app.role', ${auth.role}, true)`.execute(trx);
      store.tx = { trx, hooks };
      try {
        return await fn(trx);
      } finally {
        store.tx = undefined;
      }
    });
    await this.runHooks(hooks);
    return result;
  }

  /** Runs `fn` after the current tenant transaction commits (immediately if none is open). */
  async afterCommit(hook: AfterCommitHook): Promise<void> {
    const tx = currentStore()?.tx;
    if (tx) {
      tx.hooks.push(hook);
      return;
    }
    await this.runHooks([hook]);
  }

  /** Runs `fn` with an explicit acting context (background jobs / scripts acting as a tenant). */
  runAs<T>(auth: AuthContext, fn: () => Promise<T>): Promise<T> {
    const store: RequestStore = { auth, meta: { ip: null, userAgent: null } };
    return requestStore.run(store, fn);
  }

  /** Executes `fn` inside a SAVEPOINT so an expected failure doesn't abort the transaction. */
  async savepoint<T>(trx: Transaction<DB>, name: string, fn: () => Promise<T>): Promise<T> {
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error('invalid savepoint name');
    await sql.raw(`savepoint ${name}`).execute(trx);
    try {
      const r = await fn();
      await sql.raw(`release savepoint ${name}`).execute(trx);
      return r;
    } catch (e) {
      await sql.raw(`rollback to savepoint ${name}`).execute(trx);
      throw e;
    }
  }

  private async runHooks(hooks: AfterCommitHook[]): Promise<void> {
    for (const h of hooks) {
      try {
        await h();
      } catch (e) {
        this.logger.warn(`after-commit hook failed: ${(e as Error).message}`);
      }
    }
  }
}

import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import Redis from 'ioredis';
import { Kysely } from 'kysely';
import request from 'supertest';
import { authenticator } from 'otplib';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { createKysely } from '../src/db/db.service';
import type { DB } from '../src/db/types';
import { seed } from '../src/seed';
import { FakeEngine } from './fake-engine';

export const ADMIN_EMAIL = process.env.ADMIN_EMAIL as string;
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD as string;

export interface TestCtx {
  app: NestExpressApplication;
  http: () => request.Agent;
  engine: FakeEngine;
  /** Superuser-like view for assertions (privileged/BYPASSRLS login). */
  db: Kysely<DB>;
  /** Collects every message published on the invalidation channel. */
  invalidations: { entity: string; id: string | null }[];
  close: () => Promise<void>;
}

let counter = 0;
export function uniq(prefix: string): string {
  counter += 1;
  return `${prefix}-${process.pid}-${Date.now().toString(36)}-${counter}`;
}

/**
 * Boots the app against the fake engine. `env` (optional) sets extra environment variables
 * before the Nest module (and so loadConfig) is created; it receives the fake engine's URL.
 * They are restored by close().
 */
export async function setup(opts: { env?: (engineUrl: string) => Record<string, string> } = {}): Promise<TestCtx> {
  const engine = new FakeEngine(process.env.INTERNAL_TOKEN as string);
  process.env.ENGINE_URL = await engine.start();
  const extra = opts.env ? opts.env(engine.url) : {};
  const saved = Object.fromEntries(Object.keys(extra).map((k) => [k, process.env[k]]));
  Object.assign(process.env, extra);
  await seed({ url: process.env.DATABASE_URL_PRIVILEGED as string, email: ADMIN_EMAIL, password: ADMIN_PASSWORD, orgName: 'Platform Admin' });

  const sub = new Redis(process.env.REDIS_URL as string);
  const invalidations: { entity: string; id: string | null }[] = [];
  await sub.subscribe(process.env.CFG_INVALIDATE_CHANNEL as string);
  sub.on('message', (_ch, msg) => invalidations.push(JSON.parse(msg)));

  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = mod.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: ['error', 'warn'] });
  configureApp(app, false);
  await app.init();
  const db = createKysely(process.env.DATABASE_URL_PRIVILEGED as string, 2, 'sms-api-test');
  return {
    app,
    http: () => request.agent(app.getHttpServer()),
    engine,
    db,
    invalidations,
    close: async () => {
      await app.close();
      await db.destroy();
      sub.disconnect();
      await engine.stop();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

export interface Session {
  token: string;
  refresh: string;
  orgId: string;
  userId: string;
}

export async function login(ctx: TestCtx, email: string, password: string, totp_code?: string): Promise<Session> {
  const res = await ctx.http().post('/api/auth/login').send({ email, password, ...(totp_code ? { totp_code } : {}) });
  if (res.status !== 200 || !res.body.access_token) throw new Error(`login ${email} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { token: res.body.access_token, refresh: res.body.refresh_token, orgId: res.body.org.id, userId: res.body.user.id };
}

export function adminLogin(ctx: TestCtx): Promise<Session> {
  return login(ctx, ADMIN_EMAIL, ADMIN_PASSWORD);
}

export function as(ctx: TestCtx, s: Session) {
  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${s.token}`);
  return {
    get: (url: string) => auth(ctx.http().get(url)),
    post: (url: string, body?: unknown) => auth(ctx.http().post(url)).send(body as object),
    put: (url: string, body?: unknown) => auth(ctx.http().put(url)).send(body as object),
    patch: (url: string, body?: unknown) => auth(ctx.http().patch(url)).send(body as object),
    delete: (url: string) => auth(ctx.http().delete(url)),
  };
}

/** Creates a child org of `parent` through the API and logs in as its owner. */
export async function createChild(ctx: TestCtx, parent: Session, name = uniq('org')): Promise<Session & { email: string; password: string }> {
  const email = `${name}@test.local`.toLowerCase();
  const password = 'Child-Passw0rd!';
  const res = await as(ctx, parent).post('/api/orgs', { name, email, password });
  if (res.status !== 201) throw new Error(`create child failed: ${res.status} ${JSON.stringify(res.body)}`);
  const s = await login(ctx, email, password);
  return { ...s, email, password };
}

export function totpNow(secret: string): string {
  return authenticator.generate(secret);
}

/** TOTP code for the step `offset` steps (30s) from now (the api accepts -1..+1, each step once). */
export function totpAt(secret: string, offset: number): string {
  return authenticator.clone({ epoch: Date.now() + offset * 30_000 }).generate(secret);
}

/** Waits until at least `minLeftMs` remain in the current 30s TOTP step (keeps step offsets stable). */
export async function waitForFreshTotpStep(minLeftMs = 12_000): Promise<void> {
  const left = 30_000 - (Date.now() % 30_000);
  if (left < minLeftMs) await new Promise((r) => setTimeout(r, left + 50));
}

export async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Inserts a CDR directly (privileged), as the engine's CDR writer would. Returns its id. */
export async function insertMessage(
  ctx: TestCtx,
  m: Partial<import('../src/db/types').MessageLog> & { org_id: string; created_at?: Date },
): Promise<string> {
  const { uuidV7 } = await import('./fake-engine');
  const created = m.created_at ?? new Date();
  const id = m.id ?? uuidV7(created.getTime());
  await ctx.db
    .insertInto('message_logs')
    .values({
      channel: 'HTTP',
      destination_addr: '919876543210',
      orig_text: 'hello',
      ...m,
      id,
      created_at: created,
    } as never)
    .execute();
  return id;
}

/** Creates an API key for `s`'s org through the API; returns the full key. */
export async function createApiKey(ctx: TestCtx, s: Session, body: Record<string, unknown> = { name: 'k' }): Promise<{ id: string; key: string }> {
  const res = await as(ctx, s).post('/api/api-keys', body);
  if (res.status !== 201) throw new Error(`create api key failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { id: res.body.id, key: res.body.key };
}

/**
 * `npm run seed` — creates the SUPER_ADMIN org and its admin user from ADMIN_EMAIL /
 * ADMIN_PASSWORD. Idempotent: an existing admin org / user is reused (password untouched).
 * Uses the privileged pool (DATABASE_URL_PRIVILEGED) — seeding is a documented privileged task.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { hashPasswordArgon2id } from './crypto/crypto.service';
import { createKysely } from './db/db.service';

const env = z
  .object({
    DATABASE_URL_PRIVILEGED: z.string().min(1, 'is required'),
    ADMIN_EMAIL: z.string().trim().toLowerCase().email('must be an email'),
    ADMIN_PASSWORD: z.string().min(8, 'must be at least 8 characters'),
    ADMIN_ORG_NAME: z.string().trim().min(1).default('Platform Admin'),
  })
  .safeParse(process.env);

export async function seed(opts: { url: string; email: string; password: string; orgName: string }): Promise<{ orgId: string; userId: string; created: boolean }> {
  const db = createKysely(opts.url, 2, 'sms-api-seed');
  try {
    return await db.transaction().execute(async (trx) => {
      let created = false;
      let org = await trx.selectFrom('organizations').select(['id']).where('role', '=', 'SUPER_ADMIN').orderBy('created_at').executeTakeFirst();
      if (!org) {
        const id = randomUUID();
        await trx.insertInto('organizations').values({ id, role: 'SUPER_ADMIN', parent_id: null, name: opts.orgName, smpp_enabled: false }).execute();
        org = { id };
        created = true;
      }
      await trx.insertInto('notification_settings').values({ org_id: org.id, email_to: [opts.email] }).onConflict((oc) => oc.column('org_id').doNothing()).execute();
      const existing = await trx.selectFrom('users').select(['id', 'org_id']).where('email', '=', opts.email).executeTakeFirst();
      if (existing) {
        if (existing.org_id !== org.id) throw new Error(`${opts.email} already belongs to a non-admin organization`);
        return { orgId: org.id, userId: existing.id, created };
      }
      const user = await trx
        .insertInto('users')
        .values({ org_id: org.id, email: opts.email, password_hash: await hashPasswordArgon2id(opts.password), full_name: 'Administrator' })
        .returning('id')
        .executeTakeFirstOrThrow();
      return { orgId: org.id, userId: user.id, created: true };
    });
  } finally {
    await db.destroy();
  }
}

if (require.main === module) {
  if (!env.success) {
    // eslint-disable-next-line no-console
    console.error('seed: invalid environment\n' + env.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n'));
    process.exit(1);
  }
  seed({ url: env.data.DATABASE_URL_PRIVILEGED, email: env.data.ADMIN_EMAIL, password: env.data.ADMIN_PASSWORD, orgName: env.data.ADMIN_ORG_NAME })
    .then((r) => {
      // eslint-disable-next-line no-console
      console.log(`seed: ${r.created ? 'created' : 'already present'} — admin org ${r.orgId}, user ${r.userId}`);
    })
    .catch((e) => {
      // eslint-disable-next-line no-console
      console.error(`seed failed: ${(e as Error).message}`);
      process.exit(1);
    });
}

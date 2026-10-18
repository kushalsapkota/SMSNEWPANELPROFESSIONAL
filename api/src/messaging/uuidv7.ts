import { randomBytes } from 'node:crypto';
/**
 * message_logs ids are UUIDv7 (app.uuid_generate_v7 / engine): the first 48 bits are the
 * unix-ms creation time. Lets id lookups add a created_at window so Postgres prunes the
 * monthly partitions. Returns null for non-v7 ids (no pruning possible).
 */
export function uuidV7Time(id: string): Date | null {
  const hex = id.replace(/-/g, '');
  if (hex.length !== 32 || hex[12] !== '7') return null;
  const ms = parseInt(hex.slice(0, 12), 16);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms);
}

/** created_at search window around a v7 id's embedded time (clock skew / batch insert lag). */
export function uuidV7Window(id: string, slackMs = 2 * 86_400_000): { from: Date; to: Date } | null {
  const t = uuidV7Time(id);
  if (!t) return null;
  return { from: new Date(t.getTime() - slackMs), to: new Date(t.getTime() + slackMs) };
}

/**
 * New UUIDv7 (RFC 9562): 48-bit unix ms, version 7, variant 10, 74 random bits. The api uses
 * it for message ids it chooses itself (idempotent engine submits), so they sort and prune
 * like the engine's own ids.
 */
export function newUuidV7(ms = Date.now()): string {
  const b = randomBytes(16);
  b.writeUIntBE(ms, 0, 6);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

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

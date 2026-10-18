import { createDecipheriv } from 'node:crypto';
import { CryptoService } from '../../crypto/crypto.service';
import { loadConfig, envSchema } from '../../config/config';
import { parseCidr, cidrContains } from '../../ip-whitelist/cidr';
import { normalizeMsisdn, re2SafetyError } from '../validation';
import { sanitizeForAudit } from '../../audit/audit.service';
import { canAccessOrg, isParentOf } from '../../tenancy/scope.service';

describe('config', () => {
  it('fails fast listing every missing variable', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL[\s\S]*DATABASE_URL_PRIVILEGED[\s\S]*REDIS_URL[\s\S]*INTERNAL_TOKEN[\s\S]*ENGINE_URL[\s\S]*APP_ENC_KEY[\s\S]*JWT_SECRET/);
    expect(() => loadConfig({ ...process.env, APP_ENC_KEY: Buffer.alloc(16).toString('base64') })).toThrow(/APP_ENC_KEY/);
  });
  it('defaults the invalidation channel to the contract name', () => {
    const { CFG_INVALIDATE_CHANNEL: _omit, ...rest } = process.env;
    void _omit;
    expect(envSchema.parse(rest).CFG_INVALIDATE_CHANNEL).toBe('cfg:invalidate');
  });
});

describe('crypto (CONTRACTS §2)', () => {
  const svc = new CryptoService(loadConfig());
  it('v1: AES-256-GCM nonce||ct||tag, interoperable layout', () => {
    const enc = svc.encrypt('hunter2');
    expect(enc.startsWith('v1:')).toBe(true);
    const raw = Buffer.from(enc.slice(3), 'base64');
    expect(raw.length).toBe(12 + 7 + 16);
    const d = createDecipheriv('aes-256-gcm', Buffer.from(process.env.APP_ENC_KEY as string, 'base64'), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(raw.length - 16));
    expect(Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString()).toBe('hunter2');
    expect(svc.decrypt(enc)).toBe('hunter2');
    expect(svc.decrypt(Buffer.from(enc))).toBe('hunter2');
    expect(svc.encrypt('x')).not.toBe(svc.encrypt('x'));
  });
  it('rejects tampered ciphertext', () => {
    const enc = svc.encrypt('secret');
    const raw = Buffer.from(enc.slice(3), 'base64');
    raw[13] ^= 1;
    expect(() => svc.decrypt('v1:' + raw.toString('base64'))).toThrow();
    expect(() => svc.decrypt('v2:abc')).toThrow();
  });
  it('API keys: sk_live_ + 40 base62, prefix 12, sha256 hash', () => {
    const k = svc.generateApiKey();
    expect(k.key).toMatch(/^sk_live_[A-Za-z0-9]{40}$/);
    expect(k.prefix).toBe(k.key.slice(0, 12));
    expect(k.hash.length).toBe(32);
    expect(k.hash.equals(svc.hashApiKey(k.key))).toBe(true);
  });
  it('argon2id PHC with contract params', async () => {
    const h = await svc.hashPassword('pw');
    expect(h).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
    expect(await svc.verifyPassword(h, 'pw')).toBe(true);
    expect(await svc.verifyPassword(h, 'nope')).toBe(false);
    expect(await svc.verifyPassword('garbage', 'pw')).toBe(false);
  });
});

describe('validation helpers', () => {
  it('RE2 safety', () => {
    expect(re2SafetyError('\\b[0-9]{4,8}\\b')).toBeNull();
    expect(re2SafetyError('\\b[A-Za-z0-9]*(?:[A-Za-z][0-9]|[0-9][A-Za-z])[A-Za-z0-9]*\\b')).toBeNull();
    expect(re2SafetyError('\\\\1')).toBeNull(); // escaped backslash then digit is fine
    expect(re2SafetyError('(a)\\1')).toMatch(/backreference/);
    expect(re2SafetyError('(?=a)')).toMatch(/look-around/);
    expect(re2SafetyError('(?R)')).toMatch(/recursion/);
    expect(re2SafetyError('(')).toMatch(/invalid/);
  });
  it('MSISDN normalisation', () => {
    expect(normalizeMsisdn('+91 98765-43210')).toBe('919876543210');
    expect(normalizeMsisdn('12345')).toBeNull();
    expect(normalizeMsisdn('12a456789')).toBeNull();
  });
  it('CIDR parsing mirrors Postgres cidr', () => {
    expect(parseCidr('10.0.0.0/8')).toEqual({ cidr: '10.0.0.0/8', version: 4 });
    expect(parseCidr('10.0.0.1')).toEqual({ cidr: '10.0.0.1/32', version: 4 });
    expect(parseCidr('10.0.0.1/8')).toHaveProperty('error');
    expect(parseCidr('::1')).toEqual({ cidr: '::1/128', version: 6 });
    expect(parseCidr('2001:db8::1/32')).toHaveProperty('error');
    expect(parseCidr('fe80::/10')).toEqual({ cidr: 'fe80::/10', version: 6 });
    expect(cidrContains('127.0.0.0/8', '127.0.0.1')).toBe(true);
    expect(cidrContains('10.0.0.0/24', '10.0.1.1')).toBe(false);
    expect(cidrContains('0.0.0.0/0', '8.8.8.8')).toBe(true);
  });
  it('audit sanitizer drops credentials', () => {
    expect(sanitizeForAudit({ a: 1, password_hash: 'x', secret_enc: 'y', nested: { password_enc: 'z', ok: true }, key_hash: Buffer.from('k') })).toEqual({ a: 1, nested: { ok: true } });
  });
});

describe('authorization rules (CONTRACTS §10)', () => {
  const admin = { userId: 'u', orgId: 'A', role: 'SUPER_ADMIN' as const };
  const reseller = { userId: 'u', orgId: 'R', role: 'RESELLER' as const };
  const client = { userId: 'u', orgId: 'C', role: 'CLIENT' as const };
  const R = { id: 'R', role: 'RESELLER' as const, parent_id: 'A', name: 'r', status: 'ACTIVE' as const };
  const C = { id: 'C', role: 'CLIENT' as const, parent_id: 'R', name: 'c', status: 'ACTIVE' as const };
  const C2 = { ...C, id: 'C2', parent_id: 'R2' };
  it('matrix', () => {
    expect(canAccessOrg(admin, R, 'write')).toBe(true);
    expect(canAccessOrg(admin, C, 'read')).toBe(true);
    expect(canAccessOrg(admin, C, 'write')).toBe(false);
    expect(canAccessOrg(reseller, C, 'write')).toBe(true);
    expect(canAccessOrg(reseller, C2, 'read')).toBe(false);
    expect(canAccessOrg(client, C, 'write')).toBe(true);
    expect(canAccessOrg(client, R, 'read')).toBe(false);
    expect(isParentOf(admin, R)).toBe(true);
    expect(isParentOf(admin, C)).toBe(false);
    expect(isParentOf(reseller, C)).toBe(true);
    expect(isParentOf(client, C)).toBe(false);
  });
});

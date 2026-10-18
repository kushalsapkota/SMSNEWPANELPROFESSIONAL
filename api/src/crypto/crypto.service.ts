import { Global, Inject, Injectable, Module } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/config';

/** CONTRACTS §2: argon2id m=19456,t=2,p=1, 16-byte salt, 32-byte hash. `2` = Algorithm.Argon2id (const enum). */
export const ARGON2_PARAMS = { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1, outputLen: 32 } as const;

/** Standalone so scripts (seed) can hash without the Nest container. */
export function hashPasswordArgon2id(password: string): Promise<string> {
  return argonHash(password, { ...ARGON2_PARAMS, salt: randomBytes(16) });
}

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const ENC_PREFIX = 'v1:';

export function randomBase62(len: number): string {
  let out = '';
  for (let i = 0; i < len; i++) out += BASE62[randomInt(0, 62)];
  return out;
}

export function sha256(data: string | Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hmacSha256Hex(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export interface GeneratedApiKey {
  key: string;
  prefix: string;
  hash: Buffer;
}

@Injectable()
export class CryptoService {
  private readonly key: Buffer;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.key = Buffer.from(config.APP_ENC_KEY, 'base64');
    if (this.key.length !== 32) throw new Error('APP_ENC_KEY must decode to 32 bytes');
  }

  /** `v1:` + base64(nonce(12) || ciphertext || tag(16)), AES-256-GCM, no AAD. */
  encrypt(plaintext: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return ENC_PREFIX + Buffer.concat([nonce, ct, cipher.getAuthTag()]).toString('base64');
  }

  decrypt(value: string | Buffer): string {
    const s = Buffer.isBuffer(value) ? value.toString('utf8') : value;
    if (!s.startsWith(ENC_PREFIX)) throw new Error('unsupported ciphertext format');
    const raw = Buffer.from(s.slice(ENC_PREFIX.length), 'base64');
    if (raw.length < 12 + 16) throw new Error('ciphertext too short');
    const nonce = raw.subarray(0, 12);
    const tag = raw.subarray(raw.length - 16);
    const ct = raw.subarray(12, raw.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', this.key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }

  /** For bytea `*_enc` columns (users.totp_secret_enc): UTF-8 bytes of the v1 string. */
  encryptToBytes(plaintext: string): Buffer {
    return Buffer.from(this.encrypt(plaintext), 'utf8');
  }

  hashPassword(password: string): Promise<string> {
    return hashPasswordArgon2id(password);
  }

  async verifyPassword(hash: string, password: string): Promise<boolean> {
    try {
      return await argonVerify(hash, password);
    } catch {
      return false;
    }
  }

  /** `sk_live_` + 40 base62; prefix = first 12 chars; hash = sha256(full key). */
  generateApiKey(): GeneratedApiKey {
    const key = 'sk_live_' + randomBase62(40);
    return { key, prefix: key.slice(0, 12), hash: sha256(key) };
  }

  hashApiKey(key: string): Buffer {
    return sha256(key);
  }

  /** Opaque high-entropy token (refresh tokens). */
  randomToken(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
  }

  /** Webhook signing secret (shown once). */
  generateWebhookSecret(): string {
    return 'whsec_' + randomBytes(24).toString('base64url');
  }

  /** `xxxxx-xxxxx` lowercase base32-ish recovery code. */
  generateRecoveryCode(): string {
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
    let s = '';
    for (let i = 0; i < 10; i++) s += alphabet[randomInt(0, alphabet.length)];
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  }

  hashRecoveryCode(code: string): string {
    return sha256Hex(code.trim().toLowerCase());
  }
}

@Global()
@Module({ providers: [CryptoService], exports: [CryptoService] })
export class CryptoModule {}

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Transaction } from 'kysely';
import type { DB, OrgRole } from '../db/types';

/** Who is acting. Derived from the access JWT (CONTRACTS §10 claims). */
export interface AuthContext {
  /** `sub`: the real, logged-in user (also when impersonating). */
  userId: string;
  /** `org`: the acting org (the impersonated org while impersonating). */
  orgId: string;
  /** `role`: role of the acting org. */
  role: OrgRole;
  /** `imp`: set while impersonating (= userId). */
  impersonatorUserId?: string;
  /** `oid`: the user's own org while impersonating. */
  originalOrgId?: string;
}

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export type AfterCommitHook = () => Promise<unknown> | unknown;

export interface TxState {
  trx: Transaction<DB>;
  hooks: AfterCommitHook[];
}

export interface RequestStore {
  auth?: AuthContext;
  meta: RequestMeta;
  /** The open tenant transaction, if any (managed by DbService.tenant). */
  tx?: TxState;
}

export const requestStore = new AsyncLocalStorage<RequestStore>();

export function currentStore(): RequestStore | undefined {
  return requestStore.getStore();
}

/** The acting auth context; throws if called outside an authenticated request. */
export function currentAuth(): AuthContext {
  const auth = requestStore.getStore()?.auth;
  if (!auth) throw new Error('No authenticated request context');
  return auth;
}

export function currentMeta(): RequestMeta {
  return requestStore.getStore()?.meta ?? { ip: null, userAgent: null };
}

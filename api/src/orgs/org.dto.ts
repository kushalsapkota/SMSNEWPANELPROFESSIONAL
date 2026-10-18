import type { Organization, User } from '../db/types';

export function publicOrg(o: Organization) {
  return {
    id: o.id,
    role: o.role,
    parent_id: o.parent_id,
    name: o.name,
    status: o.status,
    suspended_reason: o.suspended_reason,
    sending_enabled: o.sending_enabled,
    api_enabled: o.api_enabled,
    smpp_enabled: o.smpp_enabled,
    web_enabled: o.web_enabled,
    max_tps: o.max_tps,
    daily_limit: o.daily_limit,
    monthly_limit: o.monthly_limit,
    brand_name: o.brand_name,
    whitelabel_domain: o.whitelabel_domain,
    timezone: o.timezone,
    settings: o.settings,
    created_at: o.created_at,
    updated_at: o.updated_at,
  };
}
export type PublicOrg = ReturnType<typeof publicOrg>;

export function publicUser(u: User) {
  return {
    id: u.id,
    org_id: u.org_id,
    email: u.email,
    full_name: u.full_name,
    is_active: u.is_active,
    totp_enabled: u.totp_enabled,
    locked_until: u.locked_until,
    last_login_at: u.last_login_at,
    last_login_ip: u.last_login_ip,
    password_changed_at: u.password_changed_at,
    created_at: u.created_at,
  };
}
export type PublicUser = ReturnType<typeof publicUser>;

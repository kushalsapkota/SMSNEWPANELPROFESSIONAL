import type { MessageLog, OrgRole } from '../db/types';

export type MessageRow = MessageLog & {
  created_at_text: string;
  org_name: string | null;
  route_name: string | null;
  connection_name: string | null;
};

/**
 * CDR as returned to the panel (column names as in message_logs, web MessageLog type).
 * What each role may see:
 *   CLIENT    its own price (client_rate/client_cost) only;
 *   RESELLER  + reseller_cost (what it pays the admin);
 *   ADMIN     everything, incl. route_cost, connection and upstream message ids.
 */
export function messageDto(m: MessageRow, role: OrgRole) {
  const admin = role === 'SUPER_ADMIN';
  const reseller = role === 'RESELLER';
  return {
    id: m.id,
    created_at: m.created_at,
    org_id: m.org_id,
    org_name: m.org_name,
    reseller_id: m.reseller_id,
    route_id: m.route_id,
    route_name: m.route_name,
    connection_id: admin ? m.connection_id : null,
    connection_name: admin ? m.connection_name : null,
    template_id: m.template_id,
    campaign_id: m.campaign_id,
    channel: m.channel,
    client_msg_ref: m.client_msg_ref,
    source_addr: m.source_addr,
    source_ton: m.source_ton,
    source_npi: m.source_npi,
    destination_addr: m.destination_addr,
    dest_ton: m.dest_ton,
    dest_npi: m.dest_npi,
    country_iso: m.country_iso,
    mccmnc: m.mccmnc,
    orig_text: m.orig_text,
    sent_text: m.sent_text,
    otp_extracted: m.otp_extracted,
    encoding: m.encoding,
    parts: m.parts,
    status: m.status,
    smsc_msg_ids: admin ? m.smsc_msg_ids : [],
    error_code: m.error_code,
    dlr_stat: m.dlr_stat,
    dlr_err: m.dlr_err,
    client_rate_micros: m.client_rate_micros,
    client_cost_micros: m.client_cost_micros,
    reseller_cost_micros: admin || reseller ? m.reseller_cost_micros : null,
    route_cost_micros: admin ? m.route_cost_micros : null,
    refunded: m.refunded,
    submitted_at: m.submitted_at,
    dlr_received_at: m.dlr_received_at,
  };
}
export type MessageDto = ReturnType<typeof messageDto>;

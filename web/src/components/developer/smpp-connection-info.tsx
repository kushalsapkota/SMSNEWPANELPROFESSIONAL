"use client";

import { useEffect, useState } from "react";
import { Panel } from "@/components/credentials";
import { CopyField } from "@/components/shared/copy-button";

export const SMPP_PORT = Number(process.env.NEXT_PUBLIC_SMPP_PORT || 2775);

/** SMPP host shown to clients (build-time override, else this panel's hostname). */
export function useSmppHost(): string {
  const [host, setHost] = useState(process.env.NEXT_PUBLIC_SMPP_HOST ?? "");
  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_SMPP_HOST) setHost(window.location.hostname);
  }, []);
  return host || "your-gateway.example.com";
}

const ROWS: Array<[string, string]> = [
  ["Protocol", "SMPP 3.4 (interface_version 0x34)"],
  ["Bind types", "TX (transmitter), RX (receiver), TRX (transceiver), as allowed per account"],
  ["Credentials", "system_id + password (max 8 chars) of an SMPP account below"],
  ["Encoding", "data_coding 0 = GSM-7, 8 = UCS-2; long messages via UDH, SAR TLVs or message_payload"],
  ["Delivery reports", "Request with registered_delivery=1; receipts arrive as deliver_sm (esm_class 0x04) on RX/TRX binds"],
  ["Receipt format", "id:<message_id> sub:001 dlvrd:001 submit date:YYMMDDhhmm done date:YYMMDDhhmm stat:DELIVRD err:000 text:…"],
  ["Receipt TLVs", "receipted_message_id (0x001E), message_state (0x0427)"],
  ["message_id", "submit_sm_resp returns the gateway message id (UUID), the same id the HTTP API and reports use"],
  ["Keep-alive", "Send enquire_link every 30-60 s; idle sessions are closed"],
  ["Throughput", "Per-account max TPS and max binds; over the limit you get ESME_RTHROTTLED (0x58)"],
];

/** Connection details for binding to the client SMPP server. */
export function SmppConnectionInfo() {
  const host = useSmppHost();
  return (
    <Panel title="SMPP connection" description="Bind your SMPP client to the gateway with these settings.">
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Host</p>
            <CopyField value={host} />
          </div>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Port</p>
            <CopyField value={String(SMPP_PORT)} />
          </div>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Address</p>
            <CopyField value={`${host}:${SMPP_PORT}`} />
          </div>
        </div>
        <dl className="divide-y rounded-md border text-sm">
          {ROWS.map(([k, v]) => (
            <div key={k} className="grid gap-1 px-3 py-2 sm:grid-cols-[10rem_1fr]">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="break-words">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Panel>
  );
}

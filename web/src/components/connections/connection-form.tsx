"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Form } from "@/components/ui/form";
import { Separator } from "@/components/ui/separator";
import {
  NumberField,
  SelectField,
  SubmitButton,
  SwitchField,
  TextareaField,
  TextField,
} from "@/components/shared/form-fields";
import type { Connection, CreateConnectionRequest } from "@/lib/api/types";

const int = (min: number, max: number) =>
  z.number({ invalid_type_error: "Required" }).int("Whole number").min(min, `≥ ${min}`).max(max, `≤ ${max}`);

function makeSchema(isCreate: boolean) {
  return z
    .object({
      name: z.string().trim().min(1, "Required").max(100),
      host: z
        .string()
        .trim()
        .min(1, "Required")
        .regex(/^[A-Za-z0-9.:\-[\]]+$/, "Hostname or IP"),
      port: int(1, 65535),
      use_tls: z.boolean(),
      system_id: z.string().trim().min(1, "Required").max(15, "Max 15 characters"),
      password: isCreate
        ? z.string().min(1, "Required").max(8, "Max 8 characters (SMPP 3.4)")
        : z.string().max(8, "Max 8 characters (SMPP 3.4)"),
      system_type: z.string().max(12, "Max 12 characters"),
      bind_type: z.enum(["TX", "RX", "TRX"]),
      sessions: int(1, 64),
      max_tps: int(1, 100_000),
      window_size: int(1, 1000),
      enquire_link_interval_s: int(1, 3600),
      reconnect_min_s: int(1, 3600),
      reconnect_max_s: int(1, 3600),
      submit_timeout_ms: int(100, 600_000),
      request_dlr: z.boolean(),
      multipart_mode: z.enum(["UDH", "SAR", "PAYLOAD"]),
      default_data_coding: int(0, 255),
      enabled: z.boolean(),
      notes: z.string().max(2000),
    })
    .refine((v) => v.reconnect_max_s >= v.reconnect_min_s, {
      path: ["reconnect_max_s"],
      message: "Must be ≥ min backoff",
    });
}

type Values = z.infer<ReturnType<typeof makeSchema>>;

const DEFAULTS: Values = {
  name: "",
  host: "",
  port: 2775,
  use_tls: false,
  system_id: "",
  password: "",
  system_type: "",
  bind_type: "TRX",
  sessions: 1,
  max_tps: 50,
  window_size: 10,
  enquire_link_interval_s: 30,
  reconnect_min_s: 1,
  reconnect_max_s: 60,
  submit_timeout_ms: 10_000,
  request_dlr: true,
  multipart_mode: "UDH",
  default_data_coding: 0,
  enabled: true,
  notes: "",
};

function toValues(c: Connection): Values {
  return {
    name: c.name,
    host: c.host ?? "",
    port: c.port ?? 2775,
    use_tls: c.use_tls,
    system_id: c.system_id ?? "",
    password: "",
    system_type: c.system_type,
    bind_type: c.bind_type,
    sessions: c.sessions,
    max_tps: c.max_tps,
    window_size: c.window_size,
    enquire_link_interval_s: c.enquire_link_interval_s,
    reconnect_min_s: c.reconnect_min_s,
    reconnect_max_s: c.reconnect_max_s,
    submit_timeout_ms: c.submit_timeout_ms,
    request_dlr: c.request_dlr,
    multipart_mode: c.multipart_mode,
    default_data_coding: c.default_data_coding,
    enabled: c.enabled,
    notes: c.notes ?? "",
  };
}

/** Values → request body. On edit an empty password is omitted (keep current). */
export function toRequest(v: Values, isCreate: boolean): CreateConnectionRequest {
  const { password, notes, ...rest } = v;
  return {
    ...rest,
    ...(isCreate || password ? { password } : {}),
    notes: notes.trim() ? notes : null,
  } as CreateConnectionRequest;
}

export function ConnectionForm({
  connection,
  pending,
  onSubmit,
  submitLabel,
}: {
  connection?: Connection;
  pending: boolean;
  onSubmit: (body: CreateConnectionRequest) => void;
  submitLabel: string;
}) {
  const isCreate = !connection;
  const form = useForm<Values>({
    resolver: zodResolver(makeSchema(isCreate)),
    defaultValues: connection ? toValues(connection) : DEFAULTS,
  });
  useEffect(() => {
    if (connection) form.reset(toValues(connection));
  }, [connection, form]);

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit((v) => onSubmit(toRequest(v, isCreate)))} className="space-y-6" noValidate>
        <section className="space-y-4">
          <h3 className="text-sm font-semibold">Endpoint</h3>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <TextField control={form.control} name="name" label="Name" />
            <TextField control={form.control} name="host" label="Host" mono placeholder="smsc.example.net" />
            <NumberField control={form.control} name="port" label="Port" min={1} max={65535} />
          </div>
          <SwitchField control={form.control} name="use_tls" label="Use TLS" description="SMPP over TLS (usually port 3550 / 8775)." />
        </section>
        <Separator />
        <section className="space-y-4">
          <h3 className="text-sm font-semibold">Credentials &amp; bind</h3>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <TextField control={form.control} name="system_id" label="System ID" mono autoComplete="off" />
            <TextField
              control={form.control}
              name="password"
              label="Password"
              type="password"
              autoComplete="new-password"
              description={isCreate ? "Max 8 characters. Write-only." : "Leave blank to keep the current password."}
            />
            <TextField control={form.control} name="system_type" label="System type" placeholder="(empty)" />
            <SelectField
              control={form.control}
              name="bind_type"
              label="Bind type"
              options={[
                { value: "TRX", label: "Transceiver (TRX)" },
                { value: "TX", label: "Transmitter (TX)" },
                { value: "RX", label: "Receiver (RX)" },
              ]}
            />
          </div>
        </section>
        <Separator />
        <section className="space-y-4">
          <h3 className="text-sm font-semibold">Throughput</h3>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <NumberField control={form.control} name="sessions" label="Sessions" min={1} max={64} />
            <NumberField control={form.control} name="max_tps" label="Max TPS (all sessions)" min={1} />
            <NumberField control={form.control} name="window_size" label="Window size" min={1} />
            <NumberField control={form.control} name="submit_timeout_ms" label="Submit timeout (ms)" min={100} />
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <NumberField control={form.control} name="enquire_link_interval_s" label="Enquire link (s)" min={1} />
            <NumberField control={form.control} name="reconnect_min_s" label="Reconnect min (s)" min={1} />
            <NumberField control={form.control} name="reconnect_max_s" label="Reconnect max (s)" min={1} />
          </div>
        </section>
        <Separator />
        <section className="space-y-4">
          <h3 className="text-sm font-semibold">Messages</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              control={form.control}
              name="multipart_mode"
              label="Multipart mode"
              options={[
                { value: "UDH", label: "UDH (8-bit ref)" },
                { value: "SAR", label: "SAR TLVs" },
                { value: "PAYLOAD", label: "message_payload TLV" },
              ]}
            />
            <NumberField control={form.control} name="default_data_coding" label="Default data_coding" min={0} max={255} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <SwitchField control={form.control} name="request_dlr" label="Request delivery reports" description="registered_delivery = 1" />
            <SwitchField control={form.control} name="enabled" label="Enabled" description="Disabled connections are unbound." />
          </div>
          <TextareaField control={form.control} name="notes" label="Notes" rows={2} />
        </section>
        <div className="flex justify-end">
          <SubmitButton pending={pending} disabled={!isCreate && !form.formState.isDirty}>
            {submitLabel}
          </SubmitButton>
        </div>
      </form>
    </Form>
  );
}

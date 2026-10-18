"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { useFieldArray, useForm, useWatch, type Control, type Resolver } from "react-hook-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Form, FormControl, FormField, FormItem, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  MoneyField,
  NumberField,
  SelectField,
  SubmitButton,
  SwitchField,
  TextareaField,
  TextField,
} from "@/components/shared/form-fields";
import { DEFAULT_PATTERNS, FALLBACK_OPTIONS } from "@/components/templates/template-editor";
import { TemplatePreview } from "@/components/templates/template-preview";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { ApiError, api, errorMessage, qk } from "@/lib/api";
import type { Adapter, QuickRouteRequest } from "@/lib/api/types";
import { HttpConnectionFields } from "@/components/connections/http/http-connection-fields";
import { useAdapters } from "@/components/connections/http/http-connection-dialog";
import {
  QUICK_ROUTE_DEFAULTS,
  makeQuickRouteSchema,
  newConnectionRow,
  priorityLabel,
  serverFieldErrors,
  toQuickRouteRequest,
  type ConnectionKind,
  type QuickRouteValues,
} from "@/lib/quick-route";
import { cn } from "@/lib/utils";

const BIND_OPTIONS = [
  { value: "TRX", label: "Transceiver (TRX)" },
  { value: "TX", label: "Transmitter (TX)" },
  { value: "RX", label: "Receiver (RX)" },
];
const MULTIPART_OPTIONS = [
  { value: "UDH", label: "UDH (8-bit ref)" },
  { value: "SAR", label: "SAR TLVs" },
  { value: "PAYLOAD", label: "message_payload TLV" },
];

function ConnectionRowEditor({
  control,
  index,
  count,
  onMove,
  onRemove,
  existingOptions,
  adapters,
  adaptersError,
}: {
  control: Control<QuickRouteValues>;
  index: number;
  count: number;
  onMove: (to: number) => void;
  onRemove: () => void;
  existingOptions: Array<{ value: string; label: string }>;
  adapters: Adapter[];
  adaptersError: string | null;
}) {
  const [advanced, setAdvanced] = useState(false);
  const kind = useWatch({ control, name: `connections.${index}.kind` });
  const p = `connections.${index}` as const;
  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={index === 0 ? "default" : "secondary"} className="tabular-nums">
          {index + 1} · {priorityLabel(index)}
        </Badge>
        <FormField
          control={control}
          name={`${p}.kind`}
          render={({ field }) => (
            <FormItem className="min-w-[200px]">
              <Select value={field.value} onValueChange={(v) => field.onChange(v as ConnectionKind)}>
                <FormControl>
                  <SelectTrigger aria-label="Connection type">
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="SMPP">SMPP (new)</SelectItem>
                  <SelectItem value="EXISTING">Existing connection</SelectItem>
                  <SelectItem value="HTTP">HTTP API (token)</SelectItem>
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
        <div className="ml-auto flex gap-1">
          <Button type="button" variant="ghost" size="icon" disabled={index === 0} onClick={() => onMove(index - 1)} aria-label="Move up">
            <ArrowUp />
          </Button>
          <Button type="button" variant="ghost" size="icon" disabled={index === count - 1} onClick={() => onMove(index + 1)} aria-label="Move down">
            <ArrowDown />
          </Button>
          <Button type="button" variant="ghost" size="icon" disabled={count === 1} onClick={onRemove} aria-label="Remove connection">
            <Trash2 />
          </Button>
        </div>
      </div>

      {kind === "EXISTING" ? (
        <SelectField
          control={control}
          name={`${p}.existing_connection_id`}
          label="Connection"
          options={existingOptions}
          placeholder={existingOptions.length ? "Select connection" : "No connections yet"}
          disabled={existingOptions.length === 0}
        />
      ) : kind === "HTTP" ? (
        <div className="space-y-4" data-testid="http-row">
          {adaptersError ? <p className="text-sm text-destructive">Cannot load the provider list: {adaptersError}</p> : null}
          <HttpConnectionFields control={control} prefix={`${p}.http`} adapters={adapters} />
          <div className="grid gap-4 sm:grid-cols-2">
            <NumberField control={control} name={`${p}.max_tps`} label="TPS" min={1} description="Messages per second sent to this provider." />
            <MoneyField control={control} name={`${p}.cost_micros`} label="Cost per SMS" placeholder="(none)" description="Default rate for all destinations." />
          </div>
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <TextField control={control} name={`${p}.host`} label="Host / IP" mono placeholder="smsc.example.net" className="sm:col-span-2" />
            <NumberField control={control} name={`${p}.port`} label="Port" min={1} max={65535} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField control={control} name={`${p}.system_id`} label="Username (system_id)" mono autoComplete="off" />
            <TextField
              control={control}
              name={`${p}.password`}
              label="Password"
              type="password"
              autoComplete="new-password"
              description="Max 8 characters (SMPP 3.4)."
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <SelectField control={control} name={`${p}.bind_type`} label="Bind type" options={BIND_OPTIONS} />
            <NumberField control={control} name={`${p}.max_tps`} label="TPS" min={1} />
            <SwitchField control={control} name={`${p}.use_tls`} label="TLS" />
          </div>
          <button
            type="button"
            className="inline-flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground"
            aria-expanded={advanced}
            onClick={() => setAdvanced((a) => !a)}
          >
            {advanced ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />} Advanced
          </button>
          {/* Kept mounted so validation errors in hidden fields still block submit. */}
          <div className={cn("space-y-4", !advanced && "hidden")}>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <TextField control={control} name={`${p}.system_type`} label="System type" placeholder="(empty)" />
              <NumberField control={control} name={`${p}.sessions`} label="Sessions" min={1} max={64} />
              <NumberField control={control} name={`${p}.window_size`} label="Window" min={1} placeholder="10" />
              <NumberField control={control} name={`${p}.enquire_link_interval_s`} label="Enquire link (s)" min={1} placeholder="30" />
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <SelectField control={control} name={`${p}.multipart_mode`} label="Multipart mode" options={MULTIPART_OPTIONS} />
              <MoneyField control={control} name={`${p}.cost_micros`} label="Cost per SMS" placeholder="(none)" description="Default rate for all destinations." />
              <SwitchField control={control} name={`${p}.request_dlr`} label="Request DLR" />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** One-step route creation: basics + connections (new SMPP inline or existing) → POST /api/routes/quick. */
export function NewRouteForm() {
  const router = useRouter();
  const adaptersQ = useAdapters();
  const adapters = adaptersQ.data?.adapters ?? [];
  // The schema depends on the (async) catalogue: resolve with the latest one.
  const adaptersRef = useRef<Adapter[]>(adapters);
  adaptersRef.current = adapters;
  const resolver: Resolver<QuickRouteValues> = (values, ctx, opts) => zodResolver(makeQuickRouteSchema(adaptersRef.current))(values, ctx, opts);
  const form = useForm<QuickRouteValues>({ resolver, defaultValues: QUICK_ROUTE_DEFAULTS });
  const { fields, append, remove, move } = useFieldArray({ control: form.control, name: "connections" });
  const conns = useQuery({
    queryKey: qk.connections.list({ page_size: 200 }),
    queryFn: () => api.connections.list({ page_size: 200 }),
  });
  const existingOptions = (conns.data?.items ?? []).map((c) => ({
    value: c.id,
    label: `${c.name} (${c.kind === "HTTP" ? (adapters.find((a) => a.id === c.adapter)?.name ?? c.adapter) : `${c.host}:${c.port}`})${c.enabled ? "" : " (disabled)"}`,
  }));
  const [templateMode, templateBody, defaultBody, fallback] = useWatch({
    control: form.control,
    name: ["template_mode", "template_body", "default_body", "template_fallback"],
  });

  const create = useApiMutation({
    mutationFn: (body: QuickRouteRequest) => api.routes.createQuick(body),
    success: (r) => `Route “${r.name}” created`,
    invalidate: [qk.routes.all, qk.connections.all, qk.templates.all, qk.dashboard],
    onSuccess: (r) => router.push(`/routes/${r.id}`),
    onError: (e) => {
      if (!(e instanceof ApiError)) return;
      for (const f of serverFieldErrors(e.details, e.message)) {
        form.setError(f.path as Parameters<typeof form.setError>[0], { type: "server", message: f.message });
      }
    },
  });

  const connError = form.formState.errors.connections?.root?.message ?? form.formState.errors.connections?.message;

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit((v) => create.mutate(toQuickRouteRequest(v, adapters)))} className="space-y-6" noValidate>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Route</CardTitle>
            <CardDescription>The routing product you assign to resellers.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField control={form.control} name="name" label="Name" placeholder="IN-OTP-Premium" />
              <TextField
                control={form.control}
                name="force_sender_id"
                label="Force sender ID"
                placeholder="(client's sender)"
                description="Overrides every client's sender on this route."
              />
            </div>
            <TextareaField control={form.control} name="description" label="Description" rows={2} />
            <div className="grid gap-4 sm:grid-cols-2">
              <SwitchField control={form.control} name="enabled" label="Enabled" />
              <SwitchField
                control={form.control}
                name="template_mode"
                label="Template mode"
                description="Extract OTPs and rewrite messages with the route template."
              />
            </div>
            {templateMode ? (
              <div className="grid gap-6 lg:grid-cols-2">
                <div className="space-y-4">
                  <SelectField control={form.control} name="template_fallback" label="Fallback when no OTP is found" options={FALLBACK_OPTIONS} />
                  <TextareaField
                    control={form.control}
                    name="template_body"
                    label="Template"
                    rows={3}
                    mono
                    description="Must contain {otp}. Also available: {brand}, {sender}."
                  />
                  {fallback === "SEND_DEFAULT_TEMPLATE" ? (
                    <TextareaField control={form.control} name="default_body" label="Default message (no OTP found)" rows={2} mono />
                  ) : null}
                </div>
                <TemplatePreview
                  valid={templateBody.includes("{otp}")}
                  template={{
                    extract_patterns: DEFAULT_PATTERNS,
                    otp_min_len: 4,
                    otp_max_len: 8,
                    template_body: templateBody,
                    default_body: defaultBody.trim() || null,
                    fallback_action: fallback,
                    brand: null,
                  }}
                />
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Connections</CardTitle>
            <CardDescription>
              Your carriers, in order: the first is the primary, the next ones are backups used when it is down or
              rejects a message.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {fields.map((f, i) => (
              <ConnectionRowEditor
                key={f.id}
                control={form.control}
                index={i}
                count={fields.length}
                onMove={(to) => move(i, to)}
                onRemove={() => remove(i)}
                existingOptions={existingOptions}
                adapters={adapters}
                adaptersError={adaptersQ.isError ? errorMessage(adaptersQ.error) : null}
              />
            ))}
            {connError ? <p className="text-sm font-medium text-destructive">{connError}</p> : null}
            <Button type="button" variant="outline" disabled={fields.length >= 10} onClick={() => append(newConnectionRow())}>
              <Plus /> Add backup connection
            </Button>
          </CardContent>
        </Card>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => router.push("/routes")}>
            Cancel
          </Button>
          <SubmitButton pending={create.isPending}>Create route</SubmitButton>
        </div>
      </form>
    </Form>
  );
}

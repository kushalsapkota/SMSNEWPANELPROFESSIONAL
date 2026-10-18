"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useForm, type FieldErrors, type Resolver } from "react-hook-form";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form } from "@/components/ui/form";
import { NumberField, SubmitButton, SwitchField, TextField } from "@/components/shared/form-fields";
import { ErrorState } from "@/components/shared/states";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { ApiError, api, qk } from "@/lib/api";
import type { Adapter, Connection } from "@/lib/api/types";
import {
  httpValuesFromConnection,
  initialHttpValues,
  toHttpCreateRequest,
  toHttpUpdateRequest,
  validateHttpConnectionForm,
  type HttpConnectionFormValues,
} from "@/lib/http-adapters";
import { HttpConnectionFields } from "./http-connection-fields";

/** Catalogue query shared by every HTTP connection UI (api caches it 60s; we keep it 5 min). */
export function useAdapters(enabled = true) {
  return useQuery({ queryKey: qk.connections.adapters, queryFn: () => api.connections.adapters(), staleTime: 5 * 60_000, enabled });
}

/** Turns flat `{path, message}` issues into react-hook-form's nested FieldErrors. */
export function issuesToErrors<T extends object>(issues: Array<{ path: string; message: string }>): FieldErrors<T> {
  const errors: Record<string, unknown> = {};
  for (const i of issues) {
    const parts = i.path.split(".");
    let cur = errors;
    parts.forEach((p, idx) => {
      if (idx === parts.length - 1) {
        if (!cur[p]) cur[p] = { type: "validate", message: i.message };
      } else {
        cur[p] = (cur[p] as Record<string, unknown>) ?? {};
        cur = cur[p] as Record<string, unknown>;
      }
    });
  }
  return errors as FieldErrors<T>;
}

const EMPTY: HttpConnectionFormValues = { name: "", max_tps: 10, enabled: true, http: initialHttpValues(undefined) };

function valuesOf(c: Connection | undefined, adapters: Adapter[]): HttpConnectionFormValues {
  if (!c) return EMPTY;
  return {
    name: c.name,
    max_tps: c.max_tps,
    enabled: c.enabled,
    http: httpValuesFromConnection(adapters.find((a) => a.id === c.adapter), c.adapter ?? "", c.settings ?? {}),
  };
}

/**
 * Create or edit an HTTP API connection. Credentials are write-only: on edit the form shows which
 * are saved, a blank field keeps the stored value, optional ones can be removed.
 */
export function HttpConnectionForm({
  connection,
  adapters,
  pending,
  submitLabel,
  onCreate,
  onUpdate,
  serverError,
}: {
  connection?: Connection;
  adapters: Adapter[];
  pending: boolean;
  submitLabel: string;
  onCreate?: (body: ReturnType<typeof toHttpCreateRequest>) => void;
  onUpdate?: (body: ReturnType<typeof toHttpUpdateRequest>) => void;
  serverError?: unknown;
}) {
  const [cleared, setCleared] = useState<string[]>([]);
  const ctx = useRef({ adapters, cleared, credentialsSet: connection?.credentials_set });
  ctx.current = { adapters, cleared, credentialsSet: connection ? connection.credentials_set : undefined };
  const resolver: Resolver<HttpConnectionFormValues> = async (values) => {
    const issues = validateHttpConnectionForm(ctx.current.adapters, values, { credentialsSet: ctx.current.credentialsSet, cleared: ctx.current.cleared });
    return issues.length ? { values: {}, errors: issuesToErrors<HttpConnectionFormValues>(issues) } : { values, errors: {} };
  };
  const form = useForm<HttpConnectionFormValues>({ resolver, defaultValues: valuesOf(connection, adapters) });
  const adaptersLoaded = adapters.length > 0;
  useEffect(() => {
    if (connection && adaptersLoaded) form.reset(valuesOf(connection, adapters));
    setCleared([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, adaptersLoaded]);

  // Server-side field errors (400 details.issues: credentials.x / settings.y / name)
  useEffect(() => {
    if (!(serverError instanceof ApiError) || !Array.isArray(serverError.details?.issues)) return;
    for (const i of serverError.details.issues as Array<{ path?: unknown; message?: unknown }>) {
      if (typeof i.path !== "string" || typeof i.message !== "string") continue;
      const path = /^(credentials|settings|adapter)/.test(i.path) ? `http.${i.path}` : i.path;
      form.setError(path as Parameters<typeof form.setError>[0], { type: "server", message: i.message });
    }
  }, [serverError, form]);

  const submit = (v: HttpConnectionFormValues) => {
    const adapter = adapters.find((a) => a.id === v.http.adapter);
    if (!adapter) return;
    if (connection) onUpdate?.(toHttpUpdateRequest(adapter, v, connection, cleared));
    else onCreate?.(toHttpCreateRequest(adapter, v));
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(submit)} className="space-y-4" noValidate aria-label="HTTP API connection">
        <div className="grid gap-4 sm:grid-cols-3">
          <TextField control={form.control} name="name" label="Name" className="sm:col-span-2" />
          <NumberField control={form.control} name="max_tps" label="Max TPS" min={1} placeholder="10" />
        </div>
        <HttpConnectionFields
          control={form.control}
          prefix="http"
          adapters={adapters}
          credentialsSet={connection ? connection.credentials_set : undefined}
          cleared={cleared}
          onToggleClear={(k) => setCleared((c) => (c.includes(k) ? c.filter((x) => x !== k) : [...c, k]))}
        />
        <SwitchField control={form.control} name="enabled" label="Enabled" description="Disabled connections carry no traffic." />
        <div className="flex justify-end">
          <SubmitButton pending={pending}>{submitLabel}</SubmitButton>
        </div>
      </form>
    </Form>
  );
}

/** Edit dialog for an existing HTTP connection (route Carrier status card). Loads the connection on open. */
export function EditHttpConnectionDialog({ connectionId, onClose }: { connectionId: string | null; onClose: () => void }) {
  const adapters = useAdapters();
  const conn = useQuery({
    queryKey: qk.connections.detail(connectionId ?? ""),
    queryFn: () => api.connections.get(connectionId as string),
    enabled: connectionId !== null,
  });
  const save = useApiMutation({
    mutationFn: (body: Parameters<typeof api.connections.update>[1]) => api.connections.update(connectionId as string, body),
    success: "Connection saved",
    invalidate: [qk.routes.all, qk.connections.all],
    onSuccess: onClose,
  });
  return (
    <Dialog open={connectionId !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit {conn.data?.name ?? "connection"}</DialogTitle>
          <DialogDescription>Saved credentials are never shown. Leave a field blank to keep it. Other routes using this connection are affected too.</DialogDescription>
        </DialogHeader>
        {conn.isError || adapters.isError ? (
          <ErrorState error={conn.error ?? adapters.error} onRetry={() => (conn.isError ? conn.refetch() : adapters.refetch())} />
        ) : conn.data && adapters.data ? (
          <HttpConnectionForm
            connection={conn.data}
            adapters={adapters.data.adapters}
            pending={save.isPending}
            submitLabel="Save"
            serverError={save.error}
            onUpdate={(body) => (Object.keys(body).length ? save.mutate(body) : onClose())}
          />
        ) : (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
      </DialogContent>
    </Dialog>
  );
}

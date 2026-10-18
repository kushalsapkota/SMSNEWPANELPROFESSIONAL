"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { Plus, Trash2, Undo2 } from "lucide-react";
import { useEffect, useMemo } from "react";
import { useFieldArray, useForm, useWatch } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Form, FormControl, FormField, FormItem, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SubmitButton } from "@/components/shared/form-fields";
import { EmptyState } from "@/components/shared/states";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { api, qk } from "@/lib/api";
import type { RouteDetail } from "@/lib/api/types";

const schema = z.object({
  rows: z
    .array(
      z.object({
        connection_id: z.string().min(1, "Pick a connection"),
        priority: z.number({ invalid_type_error: "Required" }).int().min(1, "≥ 1").max(32767),
        weight: z.number({ invalid_type_error: "Required" }).int().min(1, "≥ 1").max(32767),
        enabled: z.boolean(),
      }),
    )
    .superRefine((rows, ctx) => {
      const seen = new Set<string>();
      rows.forEach((r, i) => {
        if (seen.has(r.connection_id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, "connection_id"], message: "Already mapped" });
        seen.add(r.connection_id);
      });
    }),
});
type Values = z.infer<typeof schema>;

const toRows = (r: RouteDetail): Values["rows"] =>
  [...r.connections]
    .sort((a, b) => a.priority - b.priority || b.weight - a.weight)
    .map((c) => ({ connection_id: c.connection_id, priority: c.priority, weight: c.weight, enabled: c.enabled }));

function numberInput(field: { value: number; onChange: (v: number | null) => void; onBlur: () => void }, label: string) {
  return (
    <Input
      type="number"
      min={1}
      aria-label={label}
      value={field.value ?? ""}
      onBlur={field.onBlur}
      onChange={(e) => field.onChange(e.target.value === "" ? null : Number(e.target.value))}
    />
  );
}

/** Ordered failover / weighted load balancing across upstream connections. */
export function RouteConnectionsEditor({ route }: { route: RouteDetail }) {
  const conns = useQuery({
    queryKey: qk.connections.list({ page_size: 200 }),
    queryFn: () => api.connections.list({ page_size: 200 }),
  });
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { rows: toRows(route) } });
  const { fields, append, remove } = useFieldArray({ control: form.control, name: "rows" });
  useEffect(() => form.reset({ rows: toRows(route) }), [route, form]);
  const rows = useWatch({ control: form.control, name: "rows" });

  const share = useMemo(() => {
    // Weight share within each priority group (enabled rows only).
    const totals = new Map<number, number>();
    (rows ?? []).forEach((r) => r.enabled && totals.set(r.priority, (totals.get(r.priority) ?? 0) + (r.weight || 0)));
    return (rows ?? []).map((r) => {
      const total = totals.get(r.priority) ?? 0;
      return r.enabled && total > 0 ? Math.round(((r.weight || 0) / total) * 100) : null;
    });
  }, [rows]);

  const save = useApiMutation({
    mutationFn: (v: Values) => api.routes.replaceConnections(route.id, v.rows),
    success: "Connection mapping saved",
    invalidate: [qk.routes.all],
  });

  const options = conns.data?.items ?? [];
  const nameOf = (id: string) =>
    options.find((c) => c.id === id)?.name ?? route.connections.find((c) => c.connection_id === id)?.connection_name ?? id.slice(0, 8);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Connections</CardTitle>
        <CardDescription>
          Lowest priority with a bound session is used first; equal priorities share traffic by weight. On
          submit failure the dispatcher fails over to the next connection (max 2 failovers).
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="space-y-4" noValidate>
            {fields.length === 0 ? (
              <EmptyState title="No connections mapped" description="The route rejects traffic (ROUTE_NOT_FOUND) until at least one enabled connection is mapped." />
            ) : (
              <div className="overflow-x-auto rounded-md border">
                <Table className="min-w-[620px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Connection</TableHead>
                      <TableHead className="w-[110px]">Priority</TableHead>
                      <TableHead className="w-[110px]">Weight</TableHead>
                      <TableHead className="w-[80px] text-right">Share</TableHead>
                      <TableHead className="w-[70px]">On</TableHead>
                      <TableHead className="w-[50px]">
                        <span className="sr-only">Remove</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {fields.map((f, i) => (
                      <TableRow key={f.id}>
                        <TableCell>
                          <FormField
                            control={form.control}
                            name={`rows.${i}.connection_id`}
                            render={({ field }) => (
                              <FormItem>
                                <Select value={field.value} onValueChange={field.onChange}>
                                  <FormControl>
                                    <SelectTrigger aria-label="Connection">
                                      <SelectValue placeholder="Select connection">{field.value ? nameOf(field.value) : undefined}</SelectValue>
                                    </SelectTrigger>
                                  </FormControl>
                                  <SelectContent>
                                    {options.map((c) => (
                                      <SelectItem key={c.id} value={c.id}>
                                        {c.name}
                                        {!c.enabled ? " (disabled)" : ""}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                        </TableCell>
                        <TableCell>
                          <FormField
                            control={form.control}
                            name={`rows.${i}.priority`}
                            render={({ field }) => (
                              <FormItem>
                                <FormControl>{numberInput(field, "Priority")}</FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                        </TableCell>
                        <TableCell>
                          <FormField
                            control={form.control}
                            name={`rows.${i}.weight`}
                            render={({ field }) => (
                              <FormItem>
                                <FormControl>{numberInput(field, "Weight")}</FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {share[i] !== null && share[i] !== undefined ? `${share[i]}%` : "—"}
                        </TableCell>
                        <TableCell>
                          <FormField
                            control={form.control}
                            name={`rows.${i}.enabled`}
                            render={({ field }) => <Switch checked={field.value} onCheckedChange={field.onChange} aria-label="Enabled" />}
                          />
                        </TableCell>
                        <TableCell>
                          <Button type="button" variant="ghost" size="icon" onClick={() => remove(i)} aria-label="Remove connection">
                            <Trash2 />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={options.length === 0}
                onClick={() => {
                  const used = new Set((rows ?? []).map((r) => r.connection_id));
                  const next = options.find((c) => !used.has(c.id));
                  append({ connection_id: next?.id ?? "", priority: 1, weight: 100, enabled: true });
                }}
              >
                <Plus /> Add connection
              </Button>
              <div className="flex gap-2">
                <Button type="button" variant="ghost" disabled={!form.formState.isDirty} onClick={() => form.reset({ rows: toRows(route) })}>
                  <Undo2 /> Discard
                </Button>
                <SubmitButton pending={save.isPending} disabled={!form.formState.isDirty}>
                  Save mapping
                </SubmitButton>
              </div>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}

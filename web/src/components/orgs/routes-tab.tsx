"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Plus, Trash2, Undo2 } from "lucide-react";
import { useEffect, useMemo } from "react";
import { useFieldArray, useForm, useWatch, type Control } from "react-hook-form";
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
import { Money, MoneyInput } from "@/components/shared/money";
import { EmptyState, ErrorState, LoadingState } from "@/components/shared/states";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { api, qk } from "@/lib/api";
import type { OrgDetail, RouteAssignment } from "@/lib/api/types";
import { useSession } from "@/lib/auth/session";
import { margin } from "@/lib/money";
import { longestPrefixMatch } from "@/lib/rates";
import { cn } from "@/lib/utils";
import type { OrgKind } from "./kind";

const rowSchema = z.object({
  route_id: z.string().min(1, "Pick a route"),
  prefix: z.string().trim().regex(/^[0-9]{0,15}$/, "Digits only"),
  rate_micros: z
    .number({ invalid_type_error: "Required" })
    .int()
    .min(0, "≥ 0")
    .nullable()
    .refine((v) => v !== null, "Required"),
  priority: z.number({ invalid_type_error: "Required" }).int().min(1, "≥ 1").max(32767),
  enabled: z.boolean(),
});

const schema = z.object({
  rows: z.array(rowSchema).superRefine((rows, ctx) => {
    const seen = new Map<string, number>();
    rows.forEach((r, i) => {
      const key = `${r.route_id}|${r.prefix}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, "prefix"],
          message: "Duplicate route + prefix",
        });
      }
      seen.set(key, i);
    });
  }),
});

type Values = z.input<typeof schema>;
type Output = z.output<typeof schema>;

function toRows(items: RouteAssignment[]): Values["rows"] {
  return items.map((a) => ({
    route_id: a.route_id,
    prefix: a.prefix,
    rate_micros: a.rate_micros,
    priority: a.priority,
    enabled: a.enabled,
  }));
}

interface RouteOption {
  id: string;
  name: string;
}

/**
 * Reference cost for (route, prefix):
 *  - target RESELLER (admin editing): cheapest upstream cost among the route's
 *    enabled connections, longest-prefix matched on upstream_rates;
 *  - target CLIENT (reseller editing): the reseller's own assignment rate for
 *    that route, longest-prefix matched.
 */
function useReferenceCost(kind: OrgKind, routeIds: string[]) {
  const { org: me } = useSession();
  const own = useQuery({
    queryKey: qk.orgs.routes(me.id),
    queryFn: () => api.orgs.routes(me.id),
    enabled: kind === "client",
  });
  const details = useQueries({
    queries: (kind === "reseller" ? routeIds : []).map((id) => ({
      queryKey: qk.routes.detail(id),
      queryFn: () => api.routes.get(id),
      staleTime: 60_000,
    })),
  });
  const connectionIds = useMemo(() => {
    const ids = new Set<string>();
    details.forEach((d) => d.data?.connections.filter((c) => c.enabled).forEach((c) => ids.add(c.connection_id)));
    return Array.from(ids).sort();
  }, [details]);
  const rates = useQueries({
    queries: connectionIds.map((id) => ({
      queryKey: qk.connections.rates(id),
      queryFn: () => api.connections.rates(id),
      staleTime: 60_000,
    })),
  });

  return (routeId: string, prefix: string): number | null => {
    if (!routeId) return null;
    if (kind === "client") {
      const mine = (own.data ?? []).filter((a) => a.route_id === routeId && a.enabled);
      return longestPrefixMatch(mine, prefix)?.rate_micros ?? null;
    }
    const detail = details.find((d) => d.data?.id === routeId)?.data;
    if (!detail) return null;
    let best: number | null = null;
    for (const c of detail.connections) {
      if (!c.enabled) continue;
      const idx = connectionIds.indexOf(c.connection_id);
      const list = idx >= 0 ? rates[idx]?.data : undefined;
      if (!list) continue;
      const m = longestPrefixMatch(list, prefix);
      if (m && (best === null || m.cost_micros < best)) best = m.cost_micros;
    }
    return best;
  };
}

function MarginCell({
  control,
  index,
  reference,
  currency,
}: {
  control: Control<Values>;
  index: number;
  reference: (routeId: string, prefix: string) => number | null;
  currency: string;
}) {
  const row = useWatch({ control, name: `rows.${index}` });
  const cost = reference(row?.route_id ?? "", row?.prefix ?? "");
  const m = typeof row?.rate_micros === "number" ? margin(row.rate_micros, cost) : null;
  return (
    <>
      <TableCell className="text-right">
        <Money micros={cost} currency={currency} />
      </TableCell>
      <TableCell className="text-right">
        {m ? (
          <span className={cn("tabular-nums", m.diff < 0 ? "text-destructive" : "text-success")}>
            <Money micros={m.diff} currency={currency} />
            {m.pct !== null ? <span className="ml-1 text-xs text-muted-foreground">({m.pct.toFixed(0)}%)</span> : null}
          </span>
        ) : (
          "—"
        )}
      </TableCell>
    </>
  );
}

export function RoutesTab({ org, kind }: { org: OrgDetail; kind: OrgKind }) {
  const { org: me } = useSession();
  const currency = org.balance?.currency ?? "USD";

  const assignments = useQuery({ queryKey: qk.orgs.routes(org.id), queryFn: () => api.orgs.routes(org.id) });

  // Options: admin → every route; reseller → routes assigned to itself.
  const allRoutes = useQuery({
    queryKey: qk.routes.list({ page_size: 200 }),
    queryFn: () => api.routes.list({ page_size: 200 }),
    enabled: kind === "reseller",
  });
  const ownAssignments = useQuery({
    queryKey: qk.orgs.routes(me.id),
    queryFn: () => api.orgs.routes(me.id),
    enabled: kind === "client",
  });
  const routeOptions: RouteOption[] = useMemo(() => {
    if (kind === "reseller") return (allRoutes.data?.items ?? []).map((r) => ({ id: r.id, name: r.name }));
    const map = new Map<string, string>();
    (ownAssignments.data ?? []).filter((a) => a.enabled).forEach((a) => map.set(a.route_id, a.route_name));
    return Array.from(map, ([id, name]) => ({ id, name }));
  }, [kind, allRoutes.data, ownAssignments.data]);

  const form = useForm<Values, unknown, Output>({
    resolver: zodResolver(schema),
    defaultValues: { rows: [] },
  });
  const { fields, append, remove } = useFieldArray({ control: form.control, name: "rows" });

  useEffect(() => {
    if (assignments.data) form.reset({ rows: toRows(assignments.data) });
  }, [assignments.data, form]);

  const watchedRows = useWatch({ control: form.control, name: "rows" });
  const routeIds = useMemo(
    () => Array.from(new Set((watchedRows ?? []).map((r) => r.route_id).filter(Boolean))).sort(),
    [watchedRows],
  );
  const reference = useReferenceCost(kind, routeIds);
  const fallbackRef = (routeId: string, prefix: string) => {
    const computed = reference(routeId, prefix);
    if (computed !== null) return computed;
    return assignments.data?.find((a) => a.route_id === routeId && a.prefix === prefix)?.parent_rate_micros ?? null;
  };

  const save = useApiMutation({
    mutationFn: (v: Output) =>
      api.orgs.replaceRoutes(
        org.id,
        v.rows.map((r) => ({
          route_id: r.route_id,
          prefix: r.prefix,
          rate_micros: r.rate_micros as number,
          priority: r.priority,
          enabled: r.enabled,
        })),
      ),
    success: "Route assignments saved",
    invalidate: [qk.orgs.routes(org.id), qk.orgs.detail(org.id), qk.routes.all],
  });

  if (assignments.isLoading) return <LoadingState />;
  if (assignments.isError) return <ErrorState error={assignments.error} onRetry={() => assignments.refetch()} />;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Route assignments</CardTitle>
        <CardDescription>
          Per-segment rates by destination prefix (empty prefix = all destinations). Longest prefix wins,
          then lowest priority.{" "}
          {kind === "reseller"
            ? "Cost is the cheapest upstream rate on the route's enabled connections. Removing a route also disables it for this reseller's clients."
            : "Cost is your own rate for the route."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="space-y-4" noValidate>
            {fields.length === 0 ? (
              <EmptyState
                title="No routes assigned"
                description={
                  routeOptions.length === 0
                    ? kind === "client"
                      ? "You have no routes assigned yourself yet."
                      : "Create a route first."
                    : "This account can't send until it has at least one route."
                }
              />
            ) : (
              <div className="overflow-x-auto rounded-md border">
                <Table className="min-w-[860px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[220px]">Route</TableHead>
                      <TableHead className="w-[130px]">Prefix</TableHead>
                      <TableHead className="w-[170px]">Rate / segment</TableHead>
                      <TableHead className="text-right">{kind === "reseller" ? "Route cost" : "My cost"}</TableHead>
                      <TableHead className="text-right">Margin</TableHead>
                      <TableHead className="w-[90px]">Priority</TableHead>
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
                            name={`rows.${i}.route_id`}
                            render={({ field }) => (
                              <FormItem>
                                <Select value={field.value} onValueChange={field.onChange}>
                                  <FormControl>
                                    <SelectTrigger aria-label="Route">
                                      <SelectValue placeholder="Select route" />
                                    </SelectTrigger>
                                  </FormControl>
                                  <SelectContent>
                                    {routeOptions.map((r) => (
                                      <SelectItem key={r.id} value={r.id}>
                                        {r.name}
                                      </SelectItem>
                                    ))}
                                    {field.value && !routeOptions.some((r) => r.id === field.value) ? (
                                      <SelectItem value={field.value}>
                                        {assignments.data?.find((a) => a.route_id === field.value)?.route_name ?? field.value}
                                      </SelectItem>
                                    ) : null}
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
                            name={`rows.${i}.prefix`}
                            render={({ field }) => (
                              <FormItem>
                                <FormControl>
                                  <Input {...field} inputMode="numeric" placeholder="all" className="font-mono" aria-label="Prefix" />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                        </TableCell>
                        <TableCell>
                          <FormField
                            control={form.control}
                            name={`rows.${i}.rate_micros`}
                            render={({ field }) => (
                              <FormItem>
                                <FormControl>
                                  <MoneyInput
                                    ref={field.ref}
                                    value={field.value}
                                    onChange={field.onChange}
                                    onBlur={field.onBlur}
                                    currency={currency}
                                    aria-label="Rate per segment"
                                  />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                        </TableCell>
                        <MarginCell control={form.control} index={i} reference={fallbackRef} currency={currency} />
                        <TableCell>
                          <FormField
                            control={form.control}
                            name={`rows.${i}.priority`}
                            render={({ field }) => (
                              <FormItem>
                                <FormControl>
                                  <Input
                                    type="number"
                                    min={1}
                                    aria-label="Priority"
                                    value={field.value ?? ""}
                                    onChange={(e) => field.onChange(e.target.value === "" ? null : Number(e.target.value))}
                                  />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                        </TableCell>
                        <TableCell>
                          <FormField
                            control={form.control}
                            name={`rows.${i}.enabled`}
                            render={({ field }) => (
                              <Switch checked={field.value} onCheckedChange={field.onChange} aria-label="Enabled" />
                            )}
                          />
                        </TableCell>
                        <TableCell>
                          <Button type="button" variant="ghost" size="icon" onClick={() => remove(i)} aria-label="Remove row">
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
                disabled={routeOptions.length === 0}
                onClick={() =>
                  append({
                    route_id: routeOptions[0]?.id ?? "",
                    prefix: "",
                    rate_micros: null,
                    priority: 1,
                    enabled: true,
                  })
                }
              >
                <Plus /> Add route
              </Button>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={!form.formState.isDirty}
                  onClick={() => form.reset({ rows: toRows(assignments.data ?? []) })}
                >
                  <Undo2 /> Discard
                </Button>
                <SubmitButton pending={save.isPending} disabled={!form.formState.isDirty}>
                  Save assignments
                </SubmitButton>
              </div>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}

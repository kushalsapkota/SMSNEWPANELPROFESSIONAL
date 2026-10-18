"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { Plus, Trash2, Undo2 } from "lucide-react";
import { useEffect } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Form, FormControl, FormField, FormItem, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SubmitButton } from "@/components/shared/form-fields";
import { MoneyInput } from "@/components/shared/money";
import { EmptyState, ErrorState, LoadingState } from "@/components/shared/states";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { api, qk } from "@/lib/api";
import type { ConnectionRate } from "@/lib/api/types";

const schema = z.object({
  rows: z
    .array(
      z.object({
        prefix: z.string().trim().regex(/^[0-9]{0,15}$/, "Digits only"),
        cost_micros: z
          .number({ invalid_type_error: "Required" })
          .int()
          .min(0, "≥ 0")
          .nullable()
          .refine((v) => v !== null, "Required"),
      }),
    )
    .superRefine((rows, ctx) => {
      const seen = new Set<string>();
      rows.forEach((r, i) => {
        if (seen.has(r.prefix)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, "prefix"], message: "Duplicate prefix" });
        seen.add(r.prefix);
      });
    }),
});
type Values = z.input<typeof schema>;

const toRows = (rates: ConnectionRate[]): Values["rows"] =>
  [...rates]
    .sort((a, b) => a.prefix.localeCompare(b.prefix))
    .map((r) => ({ prefix: r.prefix, cost_micros: r.cost_micros }));

/** Upstream cost per segment by destination prefix (longest prefix wins; '' = default). */
export function RatesEditor({ connectionId, currency = "USD" }: { connectionId: string; currency?: string }) {
  const q = useQuery({ queryKey: qk.connections.rates(connectionId), queryFn: () => api.connections.rates(connectionId) });
  const form = useForm<Values, unknown, z.output<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { rows: [] } });
  const { fields, append, remove } = useFieldArray({ control: form.control, name: "rows" });
  useEffect(() => {
    if (q.data) form.reset({ rows: toRows(q.data) });
  }, [q.data, form]);

  const save = useApiMutation({
    mutationFn: (v: z.output<typeof schema>) =>
      api.connections.replaceRates(
        connectionId,
        v.rows.map((r) => ({ prefix: r.prefix, cost_micros: r.cost_micros as number })),
      ),
    success: "Rates saved",
    invalidate: [qk.connections.rates(connectionId), qk.orgs.all],
  });

  if (q.isLoading) return <LoadingState />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Upstream rates</CardTitle>
        <CardDescription>
          What this upstream charges per segment. Used for route cost and margin analytics. Empty prefix = default rate.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="space-y-4" noValidate>
            {fields.length === 0 ? (
              <EmptyState title="No rates" description="Without rates, route cost shows as unknown." />
            ) : (
              <div className="overflow-x-auto rounded-md border">
                <Table className="min-w-[420px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Prefix</TableHead>
                      <TableHead>Cost / segment</TableHead>
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
                            name={`rows.${i}.prefix`}
                            render={({ field }) => (
                              <FormItem>
                                <FormControl>
                                  <Input {...field} inputMode="numeric" placeholder="default" className="font-mono" aria-label="Prefix" />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                        </TableCell>
                        <TableCell>
                          <FormField
                            control={form.control}
                            name={`rows.${i}.cost_micros`}
                            render={({ field }) => (
                              <FormItem>
                                <FormControl>
                                  <MoneyInput
                                    ref={field.ref}
                                    value={field.value}
                                    onChange={field.onChange}
                                    onBlur={field.onBlur}
                                    currency={currency}
                                    aria-label="Cost per segment"
                                  />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                        </TableCell>
                        <TableCell>
                          <Button type="button" variant="ghost" size="icon" onClick={() => remove(i)} aria-label="Remove rate">
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
              <Button type="button" variant="outline" onClick={() => append({ prefix: "", cost_micros: null })}>
                <Plus /> Add rate
              </Button>
              <div className="flex gap-2">
                <Button type="button" variant="ghost" disabled={!form.formState.isDirty} onClick={() => form.reset({ rows: toRows(q.data ?? []) })}>
                  <Undo2 /> Discard
                </Button>
                <SubmitButton pending={save.isPending} disabled={!form.formState.isDirty}>
                  Save rates
                </SubmitButton>
              </div>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}

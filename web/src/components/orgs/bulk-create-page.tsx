"use client";

import { useQuery } from "@tanstack/react-query";
import { Copy, Download, Plus, Trash2, UserPlus } from "lucide-react";
import { useMemo, useState } from "react";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { api, qk } from "@/lib/api";
import type { BillingMode, BulkClientInput, BulkCreateResponse, OrgListItem, Route } from "@/lib/api/types";
import { toast } from "sonner";

const NO_ROUTE = "__none__"; // Select has no empty-string value; sentinel means "don't assign a route".

interface Row {
  key: string;
  reseller_id: string;
  name: string;
  email: string;
  password: string;
  billing_mode: BillingMode;
  credit_units: string; // display units (e.g. "1000"); converted to micros on submit
  smpp_system_id: string;
  smpp_password: string;
  route_id: string; // "" = no route
  rate_units: string; // display units (e.g. "0.015"); converted to micros on submit
}

const MICROS = 1_000_000;
const uid = () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : String(Math.random()));

function emptyRow(defaults: Pick<Row, "reseller_id" | "billing_mode" | "credit_units" | "route_id" | "rate_units">): Row {
  return { key: uid(), name: "", email: "", password: "", smpp_system_id: "", smpp_password: "", ...defaults };
}

export function BulkCreatePage() {
  const resellersQ = useQuery({
    queryKey: qk.orgs.list({ role: "RESELLER", page_size: 200 }),
    queryFn: () => api.orgs.list({ role: "RESELLER", page_size: 200 }),
  });
  const resellers: OrgListItem[] = resellersQ.data?.items ?? [];

  const routesQ = useQuery({
    queryKey: qk.routes.list({ page_size: 200 }),
    queryFn: () => api.routes.list({ page_size: 200 }),
  });
  const allRoutes: Route[] = routesQ.data?.items ?? [];

  // Defaults applied to new rows (and optionally pushed onto every row).
  const [defReseller, setDefReseller] = useState("");
  const [defBilling, setDefBilling] = useState<BillingMode>("POSTPAID");
  const [defCredit, setDefCredit] = useState("1000");
  const [defRoute, setDefRoute] = useState(""); // "" = no route
  const [defRate, setDefRate] = useState("0.015");
  const [namesText, setNamesText] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [result, setResult] = useState<BulkCreateResponse | null>(null);

  const resellerId = defReseller || resellers[0]?.id || "";
  const defaults = { reseller_id: resellerId, billing_mode: defBilling, credit_units: defCredit, route_id: defRoute, rate_units: defRate };

  const addRow = () => setRows((r) => [...r, emptyRow(defaults)]);
  const addFromNames = () => {
    const names = namesText
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (names.length === 0) return;
    setRows((r) => [...r, ...names.map((name) => ({ ...emptyRow(defaults), name }))]);
    setNamesText("");
  };
  const update = (key: string, patch: Partial<Row>) => setRows((r) => r.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  const remove = (key: string) => setRows((r) => r.filter((x) => x.key !== key));
  const applyDefaultsToAll = () =>
    setRows((r) =>
      r.map((x) => ({ ...x, reseller_id: resellerId, billing_mode: defBilling, credit_units: defCredit, route_id: defRoute, rate_units: defRate })),
    );

  const mutation = useApiMutation<BulkCreateResponse, BulkClientInput[]>({
    mutationFn: (clients) => api.orgs.bulkCreate({ clients }),
    success: false,
    invalidate: [qk.orgs.all, qk.auditLogs.all, qk.routes.all],
    onSuccess: (data) => {
      setResult(data);
      if (data.failed === 0) toast.success(`Created ${data.created} client${data.created === 1 ? "" : "s"}`);
      else toast.warning(`${data.created} created, ${data.failed} failed — see results`);
    },
  });

  const submit = () => {
    if (rows.length === 0) return;
    const bad = rows.find((r) => !r.reseller_id || !r.name.trim());
    if (bad) {
      toast.error("Every row needs a reseller and a name");
      return;
    }
    const clients: BulkClientInput[] = rows.map((r) => {
      const postpaid = r.billing_mode === "POSTPAID";
      const credit = Math.round(Number(r.credit_units || "0") * MICROS);
      const hasRoute = !!r.route_id;
      return {
        reseller_id: r.reseller_id,
        name: r.name.trim(),
        email: r.email.trim() || undefined,
        password: r.password.trim() || undefined,
        billing_mode: r.billing_mode,
        credit_limit_micros: postpaid ? Math.max(0, credit) : 0,
        smpp_system_id: r.smpp_system_id.trim() || undefined,
        smpp_password: r.smpp_password.trim() || undefined,
        route_id: hasRoute ? r.route_id : undefined,
        rate_micros: hasRoute ? Math.max(0, Math.round(Number(r.rate_units || "0") * MICROS)) : undefined,
      };
    });
    mutation.mutate(clients);
  };

  const created = result?.results.filter((r) => r.status === "created") ?? [];

  const csv = useMemo(() => {
    const head = ["name", "reseller", "status", "login_email", "panel_password", "smpp_system_id", "smpp_password", "route", "rate", "error"];
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rate = (r: { rate_micros?: number }) => (r.rate_micros === undefined ? "" : (r.rate_micros / MICROS).toString());
    const lines = (result?.results ?? []).map((r) =>
      [r.name, r.reseller_name, r.status, r.email, r.password, r.smpp_system_id, r.smpp_password, r.route_name, rate(r), r.error].map(esc).join(","),
    );
    return [head.join(","), ...lines].join("\n");
  }, [result]);

  const downloadCsv = () => {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `clients-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const copyCreds = async () => {
    const text = created
      .map(
        (r) =>
          `${r.name}\tsystem_id=${r.smpp_system_id}\tsmpp_pw=${r.smpp_password}\tlogin=${r.email}\tpanel_pw=${r.password}` +
          (r.route_name ? `\troute=${r.route_name}\trate=${(r.rate_micros ?? 0) / MICROS}` : ""),
      )
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Credentials copied");
    } catch {
      toast.error("Copy failed");
    }
  };

  return (
    <div>
      <PageHeader
        title="Bulk create clients"
        description="Provision many client accounts at once — each gets a panel login and an SMPP account, under the reseller you choose. Blank email / passwords / system_id are generated automatically."
        actions={
          <Button onClick={submit} disabled={rows.length === 0 || mutation.isPending}>
            <UserPlus /> {mutation.isPending ? "Creating…" : `Create ${rows.length || ""} client${rows.length === 1 ? "" : "s"}`}
          </Button>
        }
      />

      {resellers.length === 0 && !resellersQ.isLoading ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No resellers yet. Create a reseller first, then bulk-create its clients here.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Defaults &amp; quick add</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <div className="space-y-1">
                  <Label>Reseller</Label>
                  <Select value={resellerId} onValueChange={setDefReseller}>
                    <SelectTrigger aria-label="Default reseller">
                      <SelectValue placeholder="Select reseller" />
                    </SelectTrigger>
                    <SelectContent>
                      {resellers.map((r) => (
                        <SelectItem key={r.id} value={r.id}>
                          {r.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>Billing</Label>
                  <Select value={defBilling} onValueChange={(v) => setDefBilling(v as BillingMode)}>
                    <SelectTrigger aria-label="Default billing">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="PREPAID">Prepaid</SelectItem>
                      <SelectItem value="POSTPAID">Postpaid</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>Credit limit</Label>
                  <Input
                    type="number"
                    min={0}
                    value={defCredit}
                    disabled={defBilling === "PREPAID"}
                    onChange={(e) => setDefCredit(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label>Route</Label>
                  <Select value={defRoute || NO_ROUTE} onValueChange={(v) => setDefRoute(v === NO_ROUTE ? "" : v)}>
                    <SelectTrigger aria-label="Default route">
                      <SelectValue placeholder="No route" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_ROUTE}>No route</SelectItem>
                      {allRoutes.map((r) => (
                        <SelectItem key={r.id} value={r.id}>
                          {r.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>Rate (per SMS)</Label>
                  <Input
                    type="number"
                    min={0}
                    step="0.001"
                    value={defRate}
                    disabled={!defRoute}
                    onChange={(e) => setDefRate(e.target.value)}
                  />
                </div>
                <div className="flex items-end">
                  <Button type="button" variant="outline" onClick={applyDefaultsToAll} disabled={rows.length === 0}>
                    Apply to all rows
                  </Button>
                </div>
              </div>
              <div className="space-y-1">
                <Label>Quick add — paste names (one per line or comma-separated)</Label>
                <div className="flex gap-2">
                  <Textarea
                    rows={2}
                    placeholder={"casino3\ncasino4\ncasino5"}
                    value={namesText}
                    onChange={(e) => setNamesText(e.target.value)}
                  />
                  <Button type="button" variant="outline" onClick={addFromNames} disabled={!namesText.trim()}>
                    Add rows
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle className="text-base">Clients to create ({rows.length})</CardTitle>
              <Button type="button" variant="outline" size="sm" onClick={addRow}>
                <Plus /> Add row
              </Button>
            </CardHeader>
            <CardContent>
              {rows.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  No rows yet. Use “Quick add” above or “Add row”.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="min-w-[140px]">Reseller</TableHead>
                        <TableHead className="min-w-[120px]">Name</TableHead>
                        <TableHead className="min-w-[180px]">Login email</TableHead>
                        <TableHead className="min-w-[130px]">Panel password</TableHead>
                        <TableHead className="min-w-[120px]">Billing</TableHead>
                        <TableHead className="min-w-[110px]">Credit</TableHead>
                        <TableHead className="min-w-[120px]">SMPP system_id</TableHead>
                        <TableHead className="min-w-[120px]">SMPP password</TableHead>
                        <TableHead className="min-w-[150px]">Route</TableHead>
                        <TableHead className="min-w-[110px]">Rate</TableHead>
                        <TableHead />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((r) => (
                        <TableRow key={r.key}>
                          <TableCell>
                            <Select value={r.reseller_id} onValueChange={(v) => update(r.key, { reseller_id: v })}>
                              <SelectTrigger aria-label="Reseller">
                                <SelectValue placeholder="Reseller" />
                              </SelectTrigger>
                              <SelectContent>
                                {resellers.map((x) => (
                                  <SelectItem key={x.id} value={x.id}>
                                    {x.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </TableCell>
                          <TableCell>
                            <Input value={r.name} placeholder="casino3" onChange={(e) => update(r.key, { name: e.target.value })} />
                          </TableCell>
                          <TableCell>
                            <Input value={r.email} placeholder="auto" onChange={(e) => update(r.key, { email: e.target.value })} />
                          </TableCell>
                          <TableCell>
                            <Input value={r.password} placeholder="auto (16 chars)" onChange={(e) => update(r.key, { password: e.target.value })} />
                          </TableCell>
                          <TableCell>
                            <Select
                              value={r.billing_mode}
                              onValueChange={(v) => update(r.key, { billing_mode: v as BillingMode, ...(v === "PREPAID" ? { credit_units: "0" } : {}) })}
                            >
                              <SelectTrigger aria-label="Billing">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="PREPAID">Prepaid</SelectItem>
                                <SelectItem value="POSTPAID">Postpaid</SelectItem>
                              </SelectContent>
                            </Select>
                          </TableCell>
                          <TableCell>
                            <Input
                              type="number"
                              min={0}
                              value={r.credit_units}
                              disabled={r.billing_mode === "PREPAID"}
                              onChange={(e) => update(r.key, { credit_units: e.target.value })}
                            />
                          </TableCell>
                          <TableCell>
                            <Input value={r.smpp_system_id} placeholder="= name" onChange={(e) => update(r.key, { smpp_system_id: e.target.value })} />
                          </TableCell>
                          <TableCell>
                            <Input value={r.smpp_password} placeholder="auto (8 chars)" onChange={(e) => update(r.key, { smpp_password: e.target.value })} />
                          </TableCell>
                          <TableCell>
                            <Select value={r.route_id || NO_ROUTE} onValueChange={(v) => update(r.key, { route_id: v === NO_ROUTE ? "" : v })}>
                              <SelectTrigger aria-label="Route">
                                <SelectValue placeholder="No route" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value={NO_ROUTE}>No route</SelectItem>
                                {allRoutes.map((x) => (
                                  <SelectItem key={x.id} value={x.id}>
                                    {x.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </TableCell>
                          <TableCell>
                            <Input
                              type="number"
                              min={0}
                              step="0.001"
                              value={r.rate_units}
                              disabled={!r.route_id}
                              placeholder="rate"
                              onChange={(e) => update(r.key, { rate_units: e.target.value })}
                            />
                          </TableCell>
                          <TableCell>
                            <Button type="button" variant="ghost" size="icon" aria-label="Remove row" onClick={() => remove(r.key)}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          {result ? (
            <Card>
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle className="text-base">
                  Results — <span className="text-green-600 dark:text-green-500">{result.created} created</span>
                  {result.failed > 0 ? <span className="text-destructive">, {result.failed} failed</span> : null}
                </CardTitle>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={copyCreds} disabled={created.length === 0}>
                    <Copy /> Copy credentials
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={downloadCsv}>
                    <Download /> CSV
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <p className="mb-3 text-xs text-muted-foreground">
                  Passwords are shown once here — copy or download them now. SMPP host/port is your gateway’s SMPP endpoint.
                </p>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Reseller</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Login email</TableHead>
                        <TableHead>Panel password</TableHead>
                        <TableHead>SMPP system_id</TableHead>
                        <TableHead>SMPP password</TableHead>
                        <TableHead>Route</TableHead>
                        <TableHead>Rate</TableHead>
                        <TableHead>Note</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {result.results.map((r) => (
                        <TableRow key={r.index}>
                          <TableCell className="font-medium">{r.name}</TableCell>
                          <TableCell>{r.reseller_name ?? "—"}</TableCell>
                          <TableCell>
                            {r.status === "created" ? (
                              <Badge variant="outline" className="border-green-600/40 text-green-600 dark:text-green-500">created</Badge>
                            ) : (
                              <Badge variant="destructive">error</Badge>
                            )}
                          </TableCell>
                          <TableCell className="font-mono text-xs">{r.email ?? "—"}</TableCell>
                          <TableCell className="font-mono text-xs">{r.password ?? "—"}</TableCell>
                          <TableCell className="font-mono text-xs">{r.smpp_system_id ?? "—"}</TableCell>
                          <TableCell className="font-mono text-xs">{r.smpp_password ?? "—"}</TableCell>
                          <TableCell className="text-xs">{r.route_name ?? "—"}</TableCell>
                          <TableCell className="font-mono text-xs">{r.rate_micros === undefined ? "—" : r.rate_micros / MICROS}</TableCell>
                          <TableCell className="text-xs text-destructive">{r.error ?? ""}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          ) : null}
        </div>
      )}
    </div>
  );
}

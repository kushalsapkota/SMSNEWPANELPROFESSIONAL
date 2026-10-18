"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ResetFiltersButton, SelectFilter } from "@/components/data-table";
import { PageHeader } from "@/components/shared/page-header";
import { ErrorState } from "@/components/shared/states";
import { useChildOrgOptions } from "@/hooks/use-child-orgs";
import { useCurrency } from "@/hooks/use-currency";
import { useRouteOptions } from "@/hooks/use-route-options";
import { useSession } from "@/lib/auth/session";
import { moneyDescription, moneyLabels } from "@/lib/chart";
import { DateRangePicker, useDateRangeParam } from "./date-range-picker";
import {
  BREAKDOWN_TITLES,
  BreakdownCard,
  type BreakdownBy,
  DeliveryRateCard,
  MoneyOverTimeCard,
  SummaryTiles,
  TrafficCard,
  analyticsParams,
  useSummary,
} from "./widgets";

/** Single URL param helper for the page's own filters (org, route, granularity). */
function useParam(name: string) {
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const value = search.get(name) ?? undefined;
  const set = useCallback(
    (v: string | undefined) => {
      const p = new URLSearchParams(search.toString());
      if (v) p.set(name, v);
      else p.delete(name);
      const qs = p.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [search, router, pathname, name],
  );
  return [value, set] as const;
}

export function AnalyticsPage() {
  const { role } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const currency = useCurrency();
  const { range, resolved, setRange } = useDateRangeParam("7d");
  const [orgId, setOrgId] = useParam("org_id");
  const [routeId, setRouteId] = useParam("route_id");
  const [gran, setGran] = useParam("granularity");
  const children = useChildOrgOptions(role !== "CLIENT");
  const routes = useRouteOptions();

  const granularity: "hour" | "day" = gran === "hour" || gran === "day" ? gran : resolved.granularity;
  // Hourly buckets are only offered for ranges up to 7 days (≤168 points).
  const hourAllowed = resolved.to.getTime() - resolved.from.getTime() <= 7 * 86_400_000;
  const g = granularity === "hour" && !hourAllowed ? "day" : granularity;

  const params = analyticsParams(resolved, { org_id: orgId, route_id: routeId });
  const summary = useSummary(params);
  const dims: BreakdownBy[] = role === "CLIENT" ? ["route", "country", "status"] : ["route", "country", "org", "status"];
  const [tab, setTab] = useParam("by");
  const labels = moneyLabels(role);
  const childLabel = role === "SUPER_ADMIN" ? "reseller" : "client";

  return (
    <>
      <PageHeader title="Analytics" description="Traffic, delivery and money for the selected period." />

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <DateRangePicker value={range} onChange={setRange} />
        <SelectFilter
          label="Granularity"
          allLabel={`Auto (${resolved.granularity === "hour" ? "hourly" : "daily"})`}
          value={gran}
          onChange={setGran}
          options={[
            ...(hourAllowed ? [{ value: "hour", label: "Hourly" }] : []),
            { value: "day", label: "Daily" },
          ]}
          className="sm:w-40"
        />
        {role !== "CLIENT" ? (
          <SelectFilter
            label={`Filter by ${childLabel}`}
            allLabel={role === "SUPER_ADMIN" ? "All resellers" : "All clients"}
            value={orgId}
            onChange={setOrgId}
            options={children.options}
          />
        ) : null}
        <SelectFilter
          label="Filter by route"
          allLabel="All routes"
          value={routeId}
          onChange={setRouteId}
          options={routes.options.map((r) => ({ value: r.value, label: r.label }))}
        />
        <ResetFiltersButton
          visible={!!orgId || !!routeId || !!gran || range.preset !== "7d"}
          onClick={() => router.replace(pathname, { scroll: false })}
        />
      </div>

      {summary.isError ? (
        <Card className="mb-6">
          <ErrorState error={summary.error} onRetry={() => summary.refetch()} />
        </Card>
      ) : (
        <div className="mb-6">
          <SummaryTiles summary={summary.data} loading={summary.isLoading} role={role} currency={currency} />
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <TrafficCard params={params} range={resolved} granularity={g} />
        <DeliveryRateCard params={params} range={resolved} granularity={g} />
        <MoneyOverTimeCard params={params} range={resolved} granularity={g} role={role} currency={currency} />
        {role !== "CLIENT" ? (
          <BreakdownCard
            params={params}
            by="org"
            role={role}
            currency={currency}
            metric="revenue"
            title={`Top ${childLabel}s by ${labels.revenue.toLowerCase()}`}
            description={moneyDescription(role)}
          />
        ) : (
          <BreakdownCard params={params} by="status" role={role} currency={currency} title="Status distribution" description="Current status of messages in the period." />
        )}
      </div>

      <div className="mt-8">
        <h2 className="mb-3 text-lg font-semibold tracking-tight">Breakdown</h2>
        <Tabs value={tab && (dims as string[]).includes(tab) ? tab : "route"} onValueChange={(v) => setTab(v === "route" ? undefined : v)}>
          <TabsList>
            {dims.map((d) => (
              <TabsTrigger key={d} value={d}>
                {d === "org" ? (role === "SUPER_ADMIN" ? "Resellers" : "Clients") : BREAKDOWN_TITLES[d]}
              </TabsTrigger>
            ))}
          </TabsList>
          {dims.map((d) => (
            <TabsContent key={d} value={d} className="mt-4">
              <div className="grid gap-6 lg:grid-cols-2">
                <BreakdownCard
                  params={params}
                  by={d}
                  role={role}
                  currency={currency}
                  limit={10}
                  title={d === "status" ? "Status distribution" : `Messages by ${d === "org" ? childLabel : d}`}
                />
                {d !== "status" ? (
                  <BreakdownCard
                    params={params}
                    by={d}
                    role={role}
                    currency={currency}
                    limit={10}
                    metric="revenue"
                    title={`${labels.revenue} by ${d === "org" ? childLabel : d}`}
                    description={moneyDescription(role)}
                  />
                ) : null}
              </div>
            </TabsContent>
          ))}
        </Tabs>
      </div>
    </>
  );
}

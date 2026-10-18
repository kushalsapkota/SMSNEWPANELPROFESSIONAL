"use client";

import Link from "next/link";
import { Download } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { DataTable, type Column } from "@/components/data-table";
import { CopyButton } from "@/components/shared/copy-button";
import { Money } from "@/components/shared/money";
import { StatusBadge } from "@/components/shared/status-badge";
import type { SendResult, SendResultOk } from "@/lib/api/types";
import { toCsv } from "@/lib/csv";
import { formatNumber } from "@/lib/format";
import { microsToDecimalString } from "@/lib/money";
import { downloadBlob } from "@/lib/download";

export function isOk(r: SendResult): r is SendResultOk {
  return typeof (r as SendResultOk).message_id === "string";
}

/** Per-recipient outcome of a quick send. */
export function SendResults({ results, currency }: { results: SendResult[]; currency: string }) {
  const [failuresOnly, setFailuresOnly] = useState(false);
  const ok = results.filter(isOk);
  const failed = results.length - ok.length;
  const total = ok.reduce((s, r) => s + r.cost_micros, 0);
  const shown = useMemo(() => (failuresOnly ? results.filter((r) => !isOk(r)) : results), [results, failuresOnly]);
  const errorCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of results) if (!isOk(r)) m.set(r.error_code, (m.get(r.error_code) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [results]);

  const columns: Column<SendResult & { _i: number }>[] = [
    { id: "to", header: "To", cell: (r) => <span className="font-mono text-sm">{r.to}</span> },
    {
      id: "result",
      header: "Result",
      cell: (r) =>
        isOk(r) ? (
          <StatusBadge status={r.status} />
        ) : (
          <div className="space-y-0.5">
            <Badge variant="destructive">{r.error_code}</Badge>
            <p className="text-xs text-muted-foreground">{r.message}</p>
          </div>
        ),
    },
    {
      id: "id",
      header: "Message ID",
      hideOnMobile: true,
      cell: (r) =>
        isOk(r) ? (
          <span className="inline-flex items-center gap-1">
            <Link href={`/messages?q=${r.message_id}`} className="font-mono text-xs underline-offset-2 hover:underline">
              {r.message_id.slice(0, 8)}…
            </Link>
            <CopyButton value={r.message_id} label="Copy message ID" />
          </span>
        ) : (
          "—"
        ),
    },
    { id: "parts", header: "Parts", align: "right", hideOnMobile: true, cell: (r) => (isOk(r) ? r.parts : "—") },
    {
      id: "cost",
      header: "Cost",
      align: "right",
      cell: (r) => (isOk(r) ? <Money micros={r.cost_micros} currency={currency} /> : "—"),
    },
  ];

  const exportCsv = () => {
    const csv = toCsv(
      ["to", "result", "message_id", "parts", "cost", "error_message"],
      results.map((r) =>
        isOk(r)
          ? [r.to, r.status, r.message_id, String(r.parts), microsToDecimalString(r.cost_micros), ""]
          : [r.to, r.error_code, "", "", "", r.message],
      ),
    );
    downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), `send-results-${Date.now()}.csv`);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <span>
          <span className="font-semibold text-success">{formatNumber(ok.length)}</span> accepted
        </span>
        <span>
          <span className={failed ? "font-semibold text-destructive" : "font-semibold"}>{formatNumber(failed)}</span> rejected
        </span>
        <span>
          Charged <Money micros={total} currency={currency} className="font-semibold" />
        </span>
        {errorCounts.map(([code, n]) => (
          <Badge key={code} variant="outline" className="font-mono">
            {code} × {n}
          </Badge>
        ))}
        <div className="ml-auto flex items-center gap-3">
          {failed > 0 ? (
            <div className="flex items-center gap-2">
              <Switch id="failures-only" checked={failuresOnly} onCheckedChange={setFailuresOnly} />
              <Label htmlFor="failures-only" className="text-sm font-normal">
                Rejected only
              </Label>
            </div>
          ) : null}
          <Button type="button" variant="outline" size="sm" onClick={exportCsv}>
            <Download aria-hidden /> CSV
          </Button>
        </div>
      </div>
      <DataTable
        caption="Send results"
        columns={columns}
        data={shown.slice(0, 1000).map((r, i) => ({ ...r, _i: i }))}
        rowKey={(r) => `${r.to}-${r._i}`}
        empty={{ title: "No rejected recipients" }}
      />
      {shown.length > 1000 ? (
        <p className="text-xs text-muted-foreground">Showing the first 1,000 rows. Download the CSV for all {formatNumber(shown.length)}.</p>
      ) : null}
    </div>
  );
}

import { describe, expect, it } from "vitest";
import { fillTimeseries, topRows } from "@/lib/analytics";
import type { BreakdownRow } from "@/lib/api/types";

describe("fillTimeseries", () => {
  it("fills missing day buckets with zeros and derives other + rate", () => {
    const from = new Date(2026, 9, 10);
    const to = new Date(2026, 9, 13);
    const pts = fillTimeseries(
      [
        { t: "2026-10-10", messages: 10, delivered: 6, failed: 2, revenue_micros: 100 },
        { t: "2026-10-12T00:00:00Z", messages: 4, delivered: 0, failed: 0, revenue_micros: 5 },
      ],
      { from, to, granularity: "day" },
    );
    expect(pts).toHaveLength(3);
    expect(pts[0]).toMatchObject({ messages: 10, other: 2, delivery_rate: 75 });
    expect(pts[1]).toMatchObject({ messages: 0, delivery_rate: null });
    expect(pts[2]).toMatchObject({ messages: 4, other: 4, revenue_micros: 5 });
    expect(pts.map((p) => p.t)).toEqual([...pts.map((p) => p.t)].sort((a, b) => a - b));
  });

  it("aligns hourly buckets", () => {
    const from = new Date(Date.UTC(2026, 9, 18, 0));
    const to = new Date(Date.UTC(2026, 9, 18, 3));
    const pts = fillTimeseries(
      [{ t: "2026-10-18T01:00:00.000Z", messages: 3, delivered: 3, failed: 0, revenue_micros: 0 }],
      { from, to, granularity: "hour" },
    );
    expect(pts.map((p) => p.messages)).toEqual([0, 3, 0]);
  });
});

describe("topRows", () => {
  const row = (key: string, messages: number): BreakdownRow => ({
    key,
    label: key,
    messages,
    delivered: messages,
    failed: 0,
    delivery_rate: 1,
    revenue_micros: messages,
    cost_micros: 0,
  });
  it("keeps n rows, folding the tail into Other", () => {
    const r = topRows([row("a", 1), row("b", 5), row("c", 3), row("d", 2)], 3);
    expect(r.map((x) => x.key)).toEqual(["b", "c", "__other__"]);
    expect(r[2]).toMatchObject({ messages: 3, label: "Other (2)", revenue_micros: 3 });
  });
  it("returns everything sorted when short", () => {
    expect(topRows([row("a", 1), row("b", 2)], 5).map((x) => x.key)).toEqual(["b", "a"]);
  });
});

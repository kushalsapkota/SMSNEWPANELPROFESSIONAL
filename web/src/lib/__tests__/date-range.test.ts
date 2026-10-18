import { describe, expect, it } from "vitest";
import { bucketKey, bucketStarts, pointKey, rangeFromParams, resolveRange } from "@/lib/date-range";

const NOW = new Date(2026, 9, 18, 14, 25); // local 2026-10-18 14:25

describe("resolveRange", () => {
  it("today is local midnight → next midnight, hourly", () => {
    const r = resolveRange({ preset: "today" }, NOW);
    expect(r.from).toEqual(new Date(2026, 9, 18));
    expect(r.to).toEqual(new Date(2026, 9, 19));
    expect(r.granularity).toBe("hour");
  });

  it("7d covers 7 local days including today, daily", () => {
    const r = resolveRange({ preset: "7d" }, NOW);
    expect(r.from).toEqual(new Date(2026, 9, 12));
    expect(r.to).toEqual(new Date(2026, 9, 19));
    expect(r.granularity).toBe("day");
    expect(bucketStarts(r)).toHaveLength(7);
  });

  it("24h ends at the next full hour", () => {
    const r = resolveRange({ preset: "24h" }, NOW);
    expect(r.to.getTime() - r.from.getTime()).toBe(24 * 3_600_000);
    expect(r.to.getTime() % 3_600_000).toBe(0);
    expect(bucketStarts(r)).toHaveLength(24);
  });

  it("mtd starts on the 1st", () => {
    expect(resolveRange({ preset: "mtd" }, NOW).from).toEqual(new Date(2026, 9, 1));
  });

  it("custom is inclusive of the end day, clamps inverted and too-long ranges", () => {
    const r = resolveRange({ preset: "custom", fromDay: "2026-10-01", toDay: "2026-10-03" }, NOW);
    expect(r.from).toEqual(new Date(2026, 9, 1));
    expect(r.to).toEqual(new Date(2026, 9, 4));
    const inv = resolveRange({ preset: "custom", fromDay: "2026-10-05", toDay: "2026-10-01" }, NOW);
    expect(inv.to > inv.from).toBe(true);
    const long = resolveRange({ preset: "custom", fromDay: "2020-01-01", toDay: "2026-10-01" }, NOW);
    expect((long.to.getTime() - long.from.getTime()) / 86_400_000).toBeLessThanOrEqual(366);
  });

  it("reads URL params", () => {
    const p = new URLSearchParams("range=custom&from=2026-01-01&to=2026-01-31");
    expect(rangeFromParams((k) => p.get(k))).toEqual({ preset: "custom", fromDay: "2026-01-01", toDay: "2026-01-31" });
    expect(rangeFromParams(() => "bogus")).toEqual({ preset: "7d" });
  });
});

describe("bucket keys", () => {
  it("matches date-only and UTC-midnight day points on the written date", () => {
    expect(pointKey("2026-10-18", "day")).toBe("2026-10-18");
    expect(pointKey("2026-10-18T00:00:00Z", "day")).toBe("2026-10-18");
    expect(pointKey("2026-10-18T00:00:00.000+00:00", "day")).toBe("2026-10-18");
  });

  it("maps other instants to the local day / epoch hour", () => {
    const d = new Date(2026, 9, 18, 9, 0);
    expect(pointKey(d.toISOString(), "day")).toBe(bucketKey(d, "day"));
    expect(pointKey(d.toISOString(), "hour")).toBe(bucketKey(d, "hour"));
  });
});

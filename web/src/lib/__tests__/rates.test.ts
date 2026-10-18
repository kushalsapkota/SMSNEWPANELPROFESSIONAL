import { describe, expect, it } from "vitest";
import { estimateCost, pickAssignment } from "@/lib/rates";

const rows = [
  { route_id: "A", prefix: "", rate_micros: 9000, priority: 10, enabled: true },
  { route_id: "B", prefix: "91", rate_micros: 3000, priority: 10, enabled: true },
  { route_id: "C", prefix: "91", rate_micros: 2000, priority: 5, enabled: true },
  { route_id: "D", prefix: "9198", rate_micros: 1000, priority: 50, enabled: false },
];

describe("pickAssignment", () => {
  it("longest prefix, then lowest priority, skipping disabled", () => {
    expect(pickAssignment(rows, "919876543210")?.route_id).toBe("C");
    expect(pickAssignment(rows, "14155550100")?.route_id).toBe("A");
  });
  it("restricts to a forced route", () => {
    expect(pickAssignment(rows, "919876543210", "B")?.route_id).toBe("B");
    expect(pickAssignment(rows, "14155550100", "B")).toBeNull();
  });
});

describe("estimateCost", () => {
  it("multiplies by parts and reports unpriced numbers", () => {
    const e = estimateCost(rows.slice(1), ["919876543210", "918888888888", "14155550100"], 2);
    expect(e.total_micros).toBe(8000);
    expect(e.priced).toBe(2);
    expect(e.unpriced).toEqual(["14155550100"]);
    expect(e.byRoute.get("C")).toEqual({ count: 2, micros: 8000 });
  });
});

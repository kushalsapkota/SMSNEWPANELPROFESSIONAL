/** Longest-prefix matching used for rates / assignments (mirrors the engine). */
export function longestPrefixMatch<T extends { prefix: string }>(items: T[], number: string): T | null {
  let best: T | null = null;
  for (const it of items) {
    if (number.startsWith(it.prefix) && (!best || it.prefix.length > best.prefix.length)) best = it;
  }
  return best;
}

export interface RateCandidate {
  route_id: string;
  prefix: string;
  rate_micros: number;
  priority: number;
  enabled: boolean;
}

/**
 * The assignment the engine would bill for `destination` (CONTRACTS §9 step 4):
 * enabled rows whose prefix is a prefix of the number, longest prefix first,
 * then lowest priority. `routeId` restricts candidates (forced route).
 * Route/connection health is not known to the panel, so this is an estimate.
 */
export function pickAssignment<T extends RateCandidate>(items: T[], destination: string, routeId?: string): T | null {
  let best: T | null = null;
  for (const it of items) {
    if (!it.enabled || (routeId && it.route_id !== routeId) || !destination.startsWith(it.prefix)) continue;
    if (
      !best ||
      it.prefix.length > best.prefix.length ||
      (it.prefix.length === best.prefix.length && it.priority < best.priority)
    ) {
      best = it;
    }
  }
  return best;
}

export interface CostEstimate {
  /** sum over recipients with a known rate */
  total_micros: number;
  priced: number;
  /** recipients no enabled assignment covers (likely ROUTE_NOT_FOUND) */
  unpriced: string[];
  /** per-route totals */
  byRoute: Map<string, { count: number; micros: number }>;
}

/** Estimated charge for sending `parts`-part messages to each destination. */
export function estimateCost<T extends RateCandidate>(
  items: T[],
  destinations: string[],
  parts: number,
  routeId?: string,
): CostEstimate {
  const est: CostEstimate = { total_micros: 0, priced: 0, unpriced: [], byRoute: new Map() };
  for (const d of destinations) {
    const a = pickAssignment(items, d, routeId);
    if (!a) {
      est.unpriced.push(d);
      continue;
    }
    const micros = a.rate_micros * parts;
    est.total_micros += micros;
    est.priced += 1;
    const r = est.byRoute.get(a.route_id) ?? { count: 0, micros: 0 };
    r.count += 1;
    r.micros += micros;
    est.byRoute.set(a.route_id, r);
  }
  return est;
}

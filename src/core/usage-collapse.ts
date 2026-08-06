// Lifetime cost lives on disk as a SPLIT across two fields:
//
//   cumulativeCost — spend on retired agent lives (compaction swaps,
//                    /hydra agent switches, rollbacks)
//   costAmount     — spend on the CURRENT upstream session
//
// Keeping them apart is what lets a later resurrect decide whether a
// reloading agent is re-reporting history it already owns (see
// Session.reconcileCostLedger). Every WIRE shape, by contrast, has always
// exposed a single collapsed lifetime total in costAmount with cumulativeCost
// absent — see PROTOCOL.md "Cost ledger scope".
//
// Anything crossing from the persisted side to the wire side must collapse
// through here. Reading costAmount directly off a persisted record or an
// export bundle under-reports every session that has rotated its agent, and
// TypeScript cannot catch it: the wire types have all-optional fields, so a
// split-shaped object assigns to them without complaint.
//
// Daemons predating the split wrote the lifetime total into costAmount and
// omitted cumulativeCost, so summing is correct against either layout and no
// migration is required.

import type { SessionListUsage } from "../acp/types-session-list.js";

/** Either on-disk shape: PersistedUsage or an in-memory UsageSnapshot. */
export interface SplitUsage {
  used?: number | undefined;
  size?: number | undefined;
  costAmount?: number | undefined;
  costCurrency?: string | undefined;
  cumulativeCost?: number | undefined;
}

/**
 * Lifetime cost as a single number, or undefined when the record carries no
 * cost at all. Returns a number (not undefined) for a genuine zero.
 */
export function lifetimeCostOf(
  usage: SplitUsage | undefined,
): number | undefined {
  if (!usage) {
    return undefined;
  }
  if (usage.costAmount === undefined && usage.cumulativeCost === undefined) {
    return undefined;
  }
  return (usage.cumulativeCost ?? 0) + (usage.costAmount ?? 0);
}

/**
 * Collapse a persisted/in-memory split into the wire shape: costAmount holds
 * the lifetime total and cumulativeCost is dropped, so no consumer can sum the
 * two and double-count. Built field-by-field rather than by spreading, because
 * a spread would leak cumulativeCost at runtime even though SessionListUsage
 * has no slot for it.
 */
export function collapseUsage(
  usage: SplitUsage | undefined,
): SessionListUsage | undefined {
  if (!usage) {
    return undefined;
  }
  const out: SessionListUsage = {};
  if (usage.used !== undefined) {
    out.used = usage.used;
  }
  if (usage.size !== undefined) {
    out.size = usage.size;
  }
  const total = lifetimeCostOf(usage);
  if (total) {
    out.costAmount = total;
  }
  if (usage.costCurrency !== undefined) {
    out.costCurrency = usage.costCurrency;
  }
  return out;
}

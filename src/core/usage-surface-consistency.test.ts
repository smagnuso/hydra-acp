// Cross-surface consistency for lifetime cost.
//
// meta.json stores cost as a SPLIT (cumulativeCost = retired agent lives,
// costAmount = current life). Four separate surfaces have already shipped the
// bug of reading costAmount alone and under-reporting every rotated session:
// `session info`, `bundleToSummary`, the markdown transcript, and the
// read-only viewer attach _meta.
//
// Static analysis cannot close this hole. The wire types have all-optional
// fields, so a split-shaped object assigns to them with no error and no
// excess-property check — that is exactly how the viewer-meta instance got
// past both grep and a type-level probe.
//
// So this file pins the invariant behaviourally instead: ONE record, every
// surface, same number. A new surface that reads costAmount directly fails
// here even though it compiles.
import { describe, it, expect } from "vitest";
import type { Bundle } from "./bundle.js";
import { bundleToMarkdown } from "./transcript.js";
import { collapseUsage, lifetimeCostOf } from "./usage-collapse.js";
import { aggregate } from "../cli/commands/sessions-info.js";
import { bundleToSummary } from "../cli/commands/sessions.js";

// Retired lives $3.50 + current life $1.50. Every surface must say $5.00.
const SPLIT = {
  used: 12_000,
  size: 200_000,
  costAmount: 1.5,
  cumulativeCost: 3.5,
  costCurrency: "USD",
} as const;
const EXPECTED = 5;

// A daemon predating the split wrote the total into costAmount and omitted
// cumulativeCost. Must produce the identical answer — this is what makes the
// change migration-free.
const LEGACY = {
  used: 12_000,
  size: 200_000,
  costAmount: 5,
  costCurrency: "USD",
} as const;

function makeBundle(currentUsage: Record<string, unknown>): Bundle {
  return {
    version: 1 as const,
    exportedAt: "2026-06-17T00:00:00.000Z",
    exportedFrom: { machine: "testhost", hydraVersion: "0.0.0-test" },
    session: {
      sessionId: "hydra_session_consistency",
      lineageId: "hydra_lineage_consistency",
      upstreamSessionId: "ses_upstream",
      agentId: "opencode",
      cwd: "/work",
      title: "consistency",
      currentModel: "test-model",
      currentUsage,
      createdAt: "2026-06-16T00:00:00.000Z",
      updatedAt: "2026-06-17T00:00:00.000Z",
    },
    history: [],
  } as unknown as Bundle;
}

describe.each([
  ["split record", SPLIT as Record<string, unknown>],
  ["legacy collapsed record", LEGACY as Record<string, unknown>],
])("every surface agrees on lifetime cost (%s)", (_label, usage) => {
  it("lifetimeCostOf", () => {
    expect(lifetimeCostOf(usage)).toBe(EXPECTED);
  });

  it("collapseUsage (REST /v1/sessions, viewer attach _meta)", () => {
    expect(collapseUsage(usage)?.costAmount).toBe(EXPECTED);
  });

  it("aggregate (hydra session info)", () => {
    expect(aggregate(makeBundle(usage), "cold").cost.amount).toBe(EXPECTED);
  });

  it("bundleToSummary (COST column for bundle previews)", () => {
    expect(bundleToSummary(makeBundle(usage)).currentUsage?.costAmount).toBe(
      EXPECTED,
    );
  });

  it("bundleToMarkdown (exported transcript)", () => {
    const md = bundleToMarkdown(makeBundle(usage));
    expect(md).toContain(`$${EXPECTED.toFixed(2)} USD`);
    // Guard against printing the current-life portion instead of the total.
    expect(md).not.toContain("$1.50 USD");
  });
});

describe("wire shapes never leak the split", () => {
  it("collapseUsage omits cumulativeCost so consumers cannot re-add it", () => {
    const out = collapseUsage(SPLIT) as Record<string, unknown>;
    expect("cumulativeCost" in out).toBe(false);
  });

  it("bundleToSummary omits cumulativeCost", () => {
    const out = (bundleToSummary(makeBundle(SPLIT)).currentUsage ??
      {}) as Record<string, unknown>;
    expect("cumulativeCost" in out).toBe(false);
  });
});

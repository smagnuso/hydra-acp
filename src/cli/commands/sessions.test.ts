import { describe, it, expect } from "vitest";
import { bundleToSummary } from "./sessions.js";
import { toRow } from "../session-row.js";
import type { Bundle } from "../../core/bundle.js";

describe("bundleToSummary", () => {
  function bundle(overrides: Partial<Bundle["session"]> = {}): Bundle {
    return {
      version: 1,
      exportedAt: "2026-05-13T00:00:00.000Z",
      exportedFrom: { hydraVersion: "0.1.0", machine: "h" },
      session: {
        sessionId: "hydra_session_imported",
        lineageId: "hydra_lineage_x",
        agentId: "opencode",
        cwd: "/home/abakken/dev/owm",
        title: "deep scan",
        currentUsage: {
          used: 100,
          size: 1000,
          costAmount: 5,
          costCurrency: "USD",
        },
        createdAt: "2026-05-13T00:00:00.000Z",
        updatedAt: "2026-05-13T01:00:00.000Z",
        ...overrides,
      },
      history: [],
    };
  }

  it("maps the bundle's session fields into a list-row summary", () => {
    const s = bundleToSummary(bundle());
    expect(s.sessionId).toBe("hydra_session_imported");
    expect(s.cwd).toBe("/home/abakken/dev/owm");
    expect(s.agentId).toBe("opencode");
    expect(s.title).toBe("deep scan");
    expect(s.currentUsage?.costAmount).toBe(5);
    expect(s.updatedAt).toBe("2026-05-13T01:00:00.000Z");
  });

  it("surfaces the origin host in the upstream cell and renders state as cold", () => {
    const s = bundleToSummary(bundle());
    expect(s.upstreamSessionId).toBeUndefined();
    expect(s.importedFromMachine).toBe("h");
    expect(s.status).toBe("cold");
    expect(s.attachedClients).toBe(0);
    const row = toRow(s);
    expect(row.upstream).toBe("← h");
    expect(row.state).toBe("COLD");
  });

  it("threads currentUsage into the dedicated cost cell (not the agent cell)", () => {
    const s = bundleToSummary(
      bundle({
        currentUsage: {
          used: 1,
          size: 1,
          costAmount: 37.32,
          costCurrency: "USD",
        },
      }),
    );
    const row = toRow(s);
    expect(row.agent).toBe("opencode");
    expect(row.cost).toBe("$37");
  });
});

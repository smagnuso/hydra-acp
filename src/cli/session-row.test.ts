import { describe, it, expect } from "vitest";
import {
  toRow,
  computeWidths,
  formatRow,
  parseColumns,
  ALL_COLUMNS,
  DEFAULT_COLUMNS,
  HEADER,
  type FormatOptions,
  type SessionSummary,
} from "./session-row.js";

describe("toRow agent column", () => {
  it("renders just the agent id (model is intentionally omitted)", () => {
    const r = toRow({
      sessionId: "hydra_session_xyz",
      cwd: "/work",
      agentId: "opencode",
      attachedClients: 1,
      updatedAt: new Date().toISOString(),
      status: "live",
    });
    expect(r.agent).toBe("opencode");
  });

  it("renders the agent id for cold sessions too", () => {
    const r = toRow({
      sessionId: "hydra_session_xyz",
      cwd: "/work",
      agentId: "claude-acp",
      attachedClients: 0,
      updatedAt: new Date().toISOString(),
      status: "cold",
    });
    expect(r.agent).toBe("claude-acp");
  });

  it("never embeds cost in the agent cell (cost has its own column)", () => {
    const r = toRow({
      sessionId: "hydra_session_xyz",
      cwd: "/work",
      agentId: "opencode",
      currentUsage: { costAmount: 1.42, costCurrency: "USD" },
      attachedClients: 1,
      updatedAt: new Date().toISOString(),
      status: "live",
    });
    expect(r.agent).toBe("opencode");
  });
});

describe("toRow cost column", () => {
  const base = {
    sessionId: "hydra_session_xyz",
    cwd: "/work",
    agentId: "opencode",
    attachedClients: 1,
    updatedAt: new Date().toISOString(),
    status: "live" as const,
  };

  it("renders whole-dollar USD cost (cents dropped)", () => {
    const r = toRow({ ...base, currentUsage: { costAmount: 1.42 } });
    expect(r.cost).toBe("$1");
  });

  it("rounds sub-dollar amounts to the nearest dollar", () => {
    const r = toRow({ ...base, currentUsage: { costAmount: 0.42 } });
    expect(r.cost).toBe("$0");
  });

  it("renders empty when only tokens (no cost) are present", () => {
    const r = toRow({ ...base, currentUsage: { used: 1234, size: 200000 } });
    expect(r.cost).toBe("");
  });

  it("renders empty when there is no usage at all", () => {
    const r = toRow({ ...base });
    expect(r.cost).toBe("");
  });
});

describe("default columns include trailing cost", () => {
  it("DEFAULT_COLUMNS ends with cost", () => {
    expect(DEFAULT_COLUMNS[DEFAULT_COLUMNS.length - 1]).toBe("cost");
  });

  it("pushes COST flush-right after the elastic title under a width cap", () => {
    const row = toRow({
      sessionId: "hydra_session_abc",
      cwd: "/work/project",
      agentId: "opencode",
      title: "short",
      currentUsage: { costAmount: 3.5 },
      attachedClients: 0,
      updatedAt: new Date().toISOString(),
      status: "live",
    });
    const widths = computeWidths([row]);
    const line = formatRow(row, widths, 80);
    // COST is the last visible token and the line ends with it ($4 = $3.50
    // rounded to whole dollars).
    expect(line.trimEnd().endsWith("$4")).toBe(true);
  });
});

describe("toRow upstream column", () => {
  const base = {
    sessionId: "hydra_session_xyz",
    cwd: "/work",
    agentId: "opencode",
    attachedClients: 0,
    updatedAt: new Date().toISOString(),
    status: "cold" as const,
  };

  it("renders the local upstream id when it's bound", () => {
    const r = toRow({ ...base, upstreamSessionId: "u_abc" });
    expect(r.upstream).toBe("u_abc");
  });

  it("renders ← <host> when upstream is empty but the origin host is known", () => {
    const r = toRow({
      ...base,
      upstreamSessionId: "",
      importedFromMachine: "build-host",
    });
    expect(r.upstream).toBe("← build-host");
  });

  it("prefers the bound upstream id over the import-host breadcrumb", () => {
    const r = toRow({
      ...base,
      upstreamSessionId: "u_local",
      importedFromMachine: "build-host",
    });
    expect(r.upstream).toBe("u_local");
  });

  it("falls back to - when neither upstream nor origin host is known", () => {
    const r = toRow({ ...base });
    expect(r.upstream).toBe("-");
  });
});

describe("toRow state column", () => {
  const base = {
    sessionId: "hydra_session_xyz",
    cwd: "/work",
    agentId: "opencode",
    updatedAt: new Date().toISOString(),
  };

  it("renders LIVE for an idle live session", () => {
    const r = toRow({ ...base, attachedClients: 0, status: "live" });
    expect(r.state).toBe("LIVE");
  });

  it("renders LIVE• for a live session that is mid-turn", () => {
    const r = toRow({ ...base, attachedClients: 1, status: "live", busy: true });
    expect(r.state).toBe("LIVE•");
  });

  it("renders LIVE◦ for a live session awaiting user input", () => {
    const r = toRow({
      ...base,
      attachedClients: 1,
      status: "live",
      busy: true,
      awaitingInput: true,
    });
    expect(r.state).toBe("LIVE◦");
  });

  it("awaiting input wins over busy on the state glyph", () => {
    const r = toRow({
      ...base,
      attachedClients: 1,
      status: "live",
      busy: false,
      awaitingInput: true,
    });
    expect(r.state).toBe("LIVE◦");
  });

  it("renders COLD for cold sessions regardless of busy flag", () => {
    const r = toRow({ ...base, attachedClients: 0, status: "cold", busy: true });
    expect(r.state).toBe("COLD");
  });
});

describe("parseColumns", () => {
  it("parses a comma list, preserving order", () => {
    expect(parseColumns("title,state,session")).toEqual([
      "title",
      "state",
      "session",
    ]);
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseColumns(" session , cwd ")).toEqual(["session", "cwd"]);
  });

  it("rejects an unknown column name", () => {
    expect(() => parseColumns("session,bogus")).toThrow(/unknown column/);
  });

  it("rejects a duplicate column", () => {
    expect(() => parseColumns("state,state")).toThrow(/duplicate/);
  });

  it("rejects an empty list", () => {
    expect(() => parseColumns("  ")).toThrow(/no column names/);
  });
});

describe("formatRow column selection", () => {
  const summary: SessionSummary = {
    sessionId: "hydra_session_abc",
    upstreamSessionId: "u_upstream",
    cwd: "/work/project",
    agentId: "opencode",
    title: "My session",
    attachedClients: 0,
    updatedAt: new Date().toISOString(),
    status: "live",
  };

  it("omits UPSTREAM by default and includes it in the full set", () => {
    const row = toRow(summary);

    const defaultWidths = computeWidths([row]);
    const defaultHeader = formatRow(HEADER, defaultWidths);
    expect(defaultHeader).not.toContain("UPSTREAM");
    expect(defaultHeader).toContain("SESSION");
    expect(defaultHeader).toContain("TITLE");

    const fullOpts = { columns: ALL_COLUMNS };
    const fullWidths = computeWidths([row], fullOpts);
    const fullHeader = formatRow(HEADER, fullWidths, undefined, fullOpts);
    expect(fullHeader).toContain("UPSTREAM");
  });

  it("renders only the selected columns, in the given order", () => {
    const row = toRow(summary);
    const opts: FormatOptions = { columns: ["state", "session"] };
    const widths = computeWidths([row], opts);
    const header = formatRow(HEADER, widths, undefined, opts);
    // STATE precedes SESSION because that's the requested order.
    expect(header.indexOf("STATE")).toBeLessThan(header.indexOf("SESSION"));
    expect(header).not.toContain("TITLE");
    expect(header).not.toContain("CWD");
  });

  it("default and full sets fit within maxWidth", () => {
    const row = toRow(summary);
    const widths = computeWidths([row]);
    const line = formatRow(row, widths, 40);
    expect(line.length).toBeLessThanOrEqual(40);

    const fullOpts = { columns: ALL_COLUMNS };
    const fullWidths = computeWidths([row], fullOpts);
    const fullLine = formatRow(row, fullWidths, 40, fullOpts);
    expect(fullLine.length).toBeLessThanOrEqual(40);
  });

  it("DEFAULT_COLUMNS excludes upstream, host, and model", () => {
    expect(DEFAULT_COLUMNS).not.toContain("upstream");
    expect(DEFAULT_COLUMNS).not.toContain("host");
    expect(DEFAULT_COLUMNS).not.toContain("model");
    for (const c of ["upstream", "host", "model"]) {
      expect(ALL_COLUMNS).toContain(c);
    }
  });

  it("renders the model cell (provider prefix stripped) when selected", () => {
    const row = toRow({
      ...summary,
      currentModel: "ncp-anthropic/claude-opus-4",
    });
    const opts: FormatOptions = { columns: ["session", "model"] };
    const widths = computeWidths([row], opts);
    const line = formatRow(row, widths, undefined, opts);
    expect(line).toContain("claude-opus-4");
    expect(line).not.toContain("ncp-anthropic/");
  });

  it("renders '-' for model/host when the data is absent", () => {
    const row = toRow(summary);
    expect(row.model).toBe("-");
    expect(row.host).toBe("-");
  });

  it("renders the host cell from importedFromMachine when selected", () => {
    const row = toRow({ ...summary, importedFromMachine: "machine-b" });
    expect(row.host).toBe("machine-b");
    const opts: FormatOptions = { columns: ["session", "host"] };
    const widths = computeWidths([row], opts);
    const header = formatRow(HEADER, widths, undefined, opts);
    expect(header).toContain("HOST");
  });
});

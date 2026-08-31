import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it, vi, afterEach } from "vitest";
import { currentPlatformKey } from "../../core/binary-install.js";
import { paths } from "../../core/paths.js";
import { canonicalAgentId, runAgentsSet, runAgentsUninstall } from "./agents.js";
import { parseAddFlags } from "./_shared.js";

const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
const exitSpy = vi
  .spyOn(process, "exit")
  .mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code ?? 0})`);
  }) as never);

afterEach(() => {
  stdoutSpy.mockClear();
  stderrSpy.mockClear();
  exitSpy.mockClear();
});

describe("runAgentsUninstall", () => {
  it("errors and exits when no id is passed", async () => {
    await expect(runAgentsUninstall(undefined)).rejects.toThrow(/process\.exit\(2\)/);
    expect(stderrSpy).toHaveBeenCalledWith(
      "Usage: hydra-acp agent uninstall <id>\n",
    );
  });

  it("deletes the install dir when one exists", async () => {
    const platform = currentPlatformKey();
    if (platform === undefined) {
      // Unknown platform: uninstall short-circuits with exit(1). Exercise
      // that branch instead of skipping so the test remains meaningful.
      await expect(runAgentsUninstall("codex")).rejects.toThrow(
        /process\.exit\(1\)/,
      );
      return;
    }
    const id = "codex-acp";
    const installDir = path.join(paths.agentsDir(), platform, id, "1.2.3");
    await fs.mkdir(installDir, { recursive: true });
    await fs.writeFile(path.join(installDir, "marker"), "x");

    await runAgentsUninstall(id);

    await expect(fs.stat(path.join(paths.agentsDir(), platform, id))).rejects.toThrow();
    const msg = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(msg).toContain(`Uninstalled ${id}`);
  });

  it("reports 'nothing to remove' when the install dir is absent", async () => {
    const platform = currentPlatformKey();
    if (platform === undefined) {
      return;
    }
    await runAgentsUninstall("never-installed-agent");
    const msg = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(msg).toContain("Nothing to remove");
  });
});

describe("runAgentsSet", () => {
  it("sets defaultAgent when called with no configId/value", async () => {
    await runAgentsSet("claude-acp", undefined, undefined);
    const raw = JSON.parse(await fs.readFile(paths.config(), "utf8"));
    expect(raw.defaultAgent).toBe("claude-acp");
    expect(raw.sessionDefaults).toBeUndefined();
  });

  it("sets sessionDefaults[agent].model for a bare configId=model value", async () => {
    await runAgentsSet("claude-acp", "model", "claude-opus-4-7");
    const raw = JSON.parse(await fs.readFile(paths.config(), "utf8"));
    expect(raw.sessionDefaults).toEqual({
      "claude-acp": { model: "claude-opus-4-7" },
    });
    expect(raw.defaultAgent).toBeUndefined();
  });

  it("sets sessionDefaults[agent].mode for a non-model configId", async () => {
    await runAgentsSet("claude-acp", "mode", "plan");
    const raw = JSON.parse(await fs.readFile(paths.config(), "utf8"));
    expect(raw.sessionDefaults).toEqual({ "claude-acp": { mode: "plan" } });
  });

  it("accumulates multiple configId writes for the same agent", async () => {
    await runAgentsSet("claude-acp", "model", "claude-opus-4-7");
    await runAgentsSet("claude-acp", "effort", "high");
    const raw = JSON.parse(await fs.readFile(paths.config(), "utf8"));
    expect(raw.sessionDefaults).toEqual({
      "claude-acp": { model: "claude-opus-4-7", effort: "high" },
    });
  });

  it("errors and exits when configId is given without a value", async () => {
    await expect(
      runAgentsSet("claude-acp", "mode", undefined),
    ).rejects.toThrow(/process\.exit\(2\)/);
    const msg = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(msg).toContain("needs a value");
  });
});

describe("canonicalAgentId", () => {
  const known = ["pi-acp", "pi-dev", "pi-local", "claude-acp", "codex-acp"];

  it("returns an exact id unchanged", () => {
    expect(canonicalAgentId("pi-dev", known)).toBe("pi-dev");
  });

  it("resolves an implied -acp suffix over an ambiguous prefix", () => {
    expect(canonicalAgentId("pi", known)).toBe("pi-acp");
    expect(canonicalAgentId("PI", known)).toBe("pi-acp");
  });

  it("still resolves unique prefixes", () => {
    expect(canonicalAgentId("clau", known)).toBe("claude-acp");
  });

  it("returns undefined on ambiguous prefix with no -acp sibling", () => {
    expect(canonicalAgentId("c", known)).toBeUndefined();
    expect(canonicalAgentId("nope", known)).toBeUndefined();
  });
});

describe("parseAddFlags --extends", () => {
  it("parses an agent base id", () => {
    const parsed = parseAddFlags(["--extends", "opencode"], "agent");
    expect(parsed.extendsBase).toBe("opencode");
  });

  it("is undefined when not passed", () => {
    expect(parseAddFlags(["--command", "x"], "agent").extendsBase).toBeUndefined();
  });

  it("exits when --extends has no value", () => {
    expect(() => parseAddFlags(["--extends"], "agent")).toThrow(
      "process.exit(2)",
    );
  });

  it("is rejected for extensions and transformers, which have no inheritance", () => {
    expect(() => parseAddFlags(["--extends", "x"], "extension")).toThrow(
      "process.exit(2)",
    );
    expect(() => parseAddFlags(["--extends", "x"], "transformer")).toThrow(
      "process.exit(2)",
    );
    expect(stderrSpy).toHaveBeenCalledWith("Unknown flag: --extends\n");
  });

  it("still parses env and args alongside it", () => {
    const parsed = parseAddFlags(
      ["--extends", "opencode", "--env", "A=1", "--args", "acp,--x"],
      "agent",
    );
    expect(parsed.extendsBase).toBe("opencode");
    expect(parsed.env).toEqual({ A: "1" });
    expect(parsed.args).toEqual(["acp", "--x"]);
  });
});

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it, vi, afterEach } from "vitest";
import { currentPlatformKey } from "../../core/binary-install.js";
import { paths } from "../../core/paths.js";
import { runAgentsUninstall } from "./agents.js";

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

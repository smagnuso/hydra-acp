import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ensureNpmPackage } from "./npm-install.js";
import { paths } from "./paths.js";
import { currentPlatformKey } from "./binary-install.js";

describe("ensureNpmPackage", () => {
  // Save and restore PATH per test so we can simulate npm-missing and
  // fake-npm-failure scenarios without bleeding into the rest of the
  // suite.
  let originalPath: string | undefined;
  let pathSandbox: string | undefined;

  beforeEach(async () => {
    originalPath = process.env.PATH;
    pathSandbox = await fs.mkdtemp(
      path.join(process.env.HYDRA_ACP_HOME!, "path-sandbox-"),
    );
  });

  afterEach(() => {
    if (originalPath !== undefined) {
      process.env.PATH = originalPath;
    }
    pathSandbox = undefined;
  });

  it("short-circuits when the bin already exists on disk (cache hit)", async () => {
    const platformKey = currentPlatformKey()!;
    const installDir = paths.agentNpmInstallDir(
      "preinstalled",
      platformKey,
      "1.0.0",
    );
    const binDir = path.join(installDir, "node_modules", ".bin");
    await fs.mkdir(binDir, { recursive: true });
    const binPath = path.join(binDir, "preinstalled");
    await fs.writeFile(binPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    // Empty PATH so any attempt to invoke `npm` would fail — proves the
    // cache hit short-circuits and we never reach spawn.
    process.env.PATH = "";

    const result = await ensureNpmPackage({
      agentId: "preinstalled",
      version: "1.0.0",
      packageSpec: "irrelevant",
      bin: "preinstalled",
    });
    expect(result).toBe(binPath);
  });

  it("surfaces a clear error when npm is not on PATH", async () => {
    process.env.PATH = pathSandbox!;
    await expect(
      ensureNpmPackage({
        agentId: "missing-npm",
        version: "1.0.0",
        packageSpec: "some-pkg",
        bin: "some-pkg",
      }),
    ).rejects.toThrow(/npm not found on PATH/);
  });

  it("surfaces npm install failures with stderr context", async () => {
    // Stand up a fake `npm` in a sandboxed PATH that mimics an EACCES
    // failure: writes an error to stderr and exits non-zero. The temp
    // partial dir we created should be cleaned up.
    const fakeNpm = path.join(pathSandbox!, "npm");
    await fs.writeFile(
      fakeNpm,
      "#!/bin/sh\necho 'npm ERR! code EACCES' >&2\necho 'npm ERR! syscall mkdir' >&2\nexit 243\n",
      { mode: 0o755 },
    );
    process.env.PATH = pathSandbox!;

    await expect(
      ensureNpmPackage({
        agentId: "fails-install",
        version: "1.0.0",
        packageSpec: "some-pkg",
        bin: "some-pkg",
      }),
    ).rejects.toThrow(/EACCES|exit code 243/);

    // No partial dir leaked.
    const parent = path.dirname(
      paths.agentNpmInstallDir("fails-install", currentPlatformKey()!, "1.0.0"),
    );
    const leftovers = await fs.readdir(parent).catch(() => [] as string[]);
    expect(leftovers.some((name) => name.includes(".partial-"))).toBe(false);
  });

  it("surfaces a clear error when the install succeeds but the bin is missing", async () => {
    // Fake npm that "succeeds" without producing anything in
    // node_modules/.bin. Models a package whose declared bin name
    // doesn't match its actual one.
    const fakeNpm = path.join(pathSandbox!, "npm");
    await fs.writeFile(
      fakeNpm,
      "#!/bin/sh\nmkdir -p node_modules/.bin\nexit 0\n",
      { mode: 0o755 },
    );
    process.env.PATH = pathSandbox!;

    await expect(
      ensureNpmPackage({
        agentId: "wrong-bin",
        version: "1.0.0",
        packageSpec: "some-pkg",
        bin: "ghost-bin",
      }),
    ).rejects.toThrow(/did not produce bin ghost-bin/);
  });

  it("uses a fresh install dir per Node ABI (path keyed by process.versions.modules)", () => {
    const a = paths.agentNpmInstallDir("x", "linux-x86_64", "1.0.0");
    expect(a).toContain(`node${process.versions.modules}`);
  });
});

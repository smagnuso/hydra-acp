import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ensureNpmPackage, type NpmInstallProgress } from "./npm-install.js";
import { paths } from "./paths.js";
import { currentPlatformKey } from "./binary-install.js";
import { writeExecutable } from "../__tests__/test-utils.js";

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
    await writeExecutable(
      fakeNpm,
      "#!/bin/sh\necho 'npm ERR! code EACCES' >&2\necho 'npm ERR! syscall mkdir' >&2\nexit 243\n",
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
    await writeExecutable(
      fakeNpm,
      "#!/bin/sh\nmkdir -p node_modules/.bin\nexit 0\n",
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

  it("emits install_start then installed via onProgress on a successful install", async () => {
    // Fake npm that creates the expected bin so ensureNpmPackage's
    // post-install check passes — we only care about the progress
    // event sequence here, not the actual install semantics.
    //
    // Absolute paths to mkdir/touch/chmod because the surrounding tests
    // set PATH to a single sandbox dir; without that, the shell builtin
    // lookup fails and the script silently produces nothing.
    const fakeNpm = path.join(pathSandbox!, "npm");
    // Restore /bin:/usr/bin inside the script so mkdir/touch/chmod
    // resolve — the outer test deliberately scopes PATH to the sandbox
    // (to prove npm-not-found surfacing), but here we need a working
    // shell to actually drop the expected bin on disk.
    await writeExecutable(
      fakeNpm,
      "#!/bin/sh\nexport PATH=/bin:/usr/bin\nmkdir -p node_modules/.bin\ntouch node_modules/.bin/progress-bin\nchmod +x node_modules/.bin/progress-bin\nexit 0\n",
    );
    process.env.PATH = pathSandbox!;
    const events: NpmInstallProgress[] = [];
    await ensureNpmPackage({
      agentId: "progress-pkg",
      version: "1.0.0",
      packageSpec: "progress-pkg@1.0.0",
      bin: "progress-bin",
      onProgress: (e) => events.push(e),
    });
    expect(events.length).toBe(2);
    expect(events[0]).toMatchObject({
      phase: "install_start",
      agentId: "progress-pkg",
      version: "1.0.0",
      packageSpec: "progress-pkg@1.0.0",
    });
    expect(events[1]).toMatchObject({
      phase: "installed",
      agentId: "progress-pkg",
      version: "1.0.0",
    });
  });

  it("does not call onProgress when the bin is already cached", async () => {
    const platformKey = currentPlatformKey()!;
    const installDir = paths.agentNpmInstallDir(
      "cached-pkg",
      platformKey,
      "1.0.0",
    );
    const binDir = path.join(installDir, "node_modules", ".bin");
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(path.join(binDir, "cached-pkg"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    process.env.PATH = "";

    const events: NpmInstallProgress[] = [];
    await ensureNpmPackage({
      agentId: "cached-pkg",
      version: "1.0.0",
      packageSpec: "cached-pkg",
      bin: "cached-pkg",
      onProgress: (e) => events.push(e),
    });
    expect(events).toEqual([]);
  });

  it("resolves bin from package.json when hint doesn't match the real bin name", async () => {
    // Models the qwen-code case: package is @qwen-code/qwen-code but the
    // bin it declares is "qwen", not the basename "qwen-code".
    const fakeNpm = path.join(pathSandbox!, "npm");
    await writeExecutable(
      fakeNpm,
      [
        "#!/bin/sh",
        "export PATH=/bin:/usr/bin",
        'mkdir -p node_modules/.bin "node_modules/@qwen-code/qwen-code"',
        'printf \'{"bin":{"qwen":"./cli.js"}}\' > "node_modules/@qwen-code/qwen-code/package.json"',
        "touch node_modules/.bin/qwen",
        "chmod +x node_modules/.bin/qwen",
        "exit 0",
      ].join("\n"),
    );
    process.env.PATH = pathSandbox!;

    const result = await ensureNpmPackage({
      agentId: "qwen-code",
      version: "0.16.0",
      packageSpec: "@qwen-code/qwen-code@0.16.0",
      bin: "qwen-code",
    });
    expect(result).toMatch(/node_modules[\\/]\.bin[\\/]qwen$/);
  });

  it("falls back to basename when package.json declares bin as a string", async () => {
    // bin: "./cli.js" (string form) — npm populates .bin/<basename>, so the
    // basename heuristic handles it correctly.
    const fakeNpm = path.join(pathSandbox!, "npm");
    await writeExecutable(
      fakeNpm,
      [
        "#!/bin/sh",
        "export PATH=/bin:/usr/bin",
        'mkdir -p node_modules/.bin node_modules/string-bin-pkg',
        'printf \'{"bin":"./cli.js"}\' > node_modules/string-bin-pkg/package.json',
        "touch node_modules/.bin/string-bin-pkg",
        "chmod +x node_modules/.bin/string-bin-pkg",
        "exit 0",
      ].join("\n"),
    );
    process.env.PATH = pathSandbox!;

    const result = await ensureNpmPackage({
      agentId: "string-bin-pkg",
      version: "1.0.0",
      packageSpec: "string-bin-pkg@1.0.0",
      bin: "wrong-hint",
    });
    expect(result).toMatch(/node_modules[\\/]\.bin[\\/]string-bin-pkg$/);
  });

  it("picks matching key from a multi-bin package.json via basename", async () => {
    const fakeNpm = path.join(pathSandbox!, "npm");
    await writeExecutable(
      fakeNpm,
      [
        "#!/bin/sh",
        "export PATH=/bin:/usr/bin",
        'mkdir -p node_modules/.bin node_modules/multi-tool',
        'printf \'{"bin":{"multi-tool":"./main.js","multi-tool-legacy":"./legacy.js"}}\' > node_modules/multi-tool/package.json',
        "touch node_modules/.bin/multi-tool node_modules/.bin/multi-tool-legacy",
        "chmod +x node_modules/.bin/multi-tool node_modules/.bin/multi-tool-legacy",
        "exit 0",
      ].join("\n"),
    );
    process.env.PATH = pathSandbox!;

    // hint is wrong but basename "multi-tool" matches a key in the object
    const result = await ensureNpmPackage({
      agentId: "multi-tool",
      version: "1.0.0",
      packageSpec: "multi-tool@1.0.0",
      bin: "wrong-hint",
    });
    expect(result).toMatch(/node_modules[\\/]\.bin[\\/]multi-tool$/);
  });

  it("includes declared bins in the error when no candidate matches", async () => {
    const fakeNpm = path.join(pathSandbox!, "npm");
    await writeExecutable(
      fakeNpm,
      [
        "#!/bin/sh",
        "export PATH=/bin:/usr/bin",
        'mkdir -p node_modules/.bin node_modules/ambiguous-pkg',
        'printf \'{"bin":{"foo":"./foo.js","bar":"./bar.js"}}\' > node_modules/ambiguous-pkg/package.json',
        "touch node_modules/.bin/foo node_modules/.bin/bar",
        "chmod +x node_modules/.bin/foo node_modules/.bin/bar",
        "exit 0",
      ].join("\n"),
    );
    process.env.PATH = pathSandbox!;

    // hint "ghost" and basename "ambiguous-pkg" don't match "foo" or "bar"
    await expect(
      ensureNpmPackage({
        agentId: "ambiguous",
        version: "1.0.0",
        packageSpec: "ambiguous-pkg@1.0.0",
        bin: "ghost",
      }),
    ).rejects.toThrow(/did not produce bin ghost.*package declares bins: (foo, bar|bar, foo)/);
  });

  it("resolves from installed package.json without re-running npm (slow-path cache)", async () => {
    // Pre-populate the install dir as if a previous run already installed the
    // package (hint-mismatched bin was never placed, but the real bin is there).
    const platformKey = currentPlatformKey()!;
    const installDir = paths.agentNpmInstallDir(
      "slow-cache-pkg",
      platformKey,
      "1.0.0",
    );
    const binDir = path.join(installDir, "node_modules", ".bin");
    const pkgDir = path.join(installDir, "node_modules", "slow-cache-pkg");
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(pkgDir, { recursive: true });
    await fs.writeFile(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ bin: { "slow-cache-real": "./cli.js" } }),
    );
    await fs.writeFile(path.join(binDir, "slow-cache-real"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });

    // Empty PATH: any npm invocation would fail, proving we never re-install.
    process.env.PATH = "";

    const result = await ensureNpmPackage({
      agentId: "slow-cache-pkg",
      version: "1.0.0",
      packageSpec: "slow-cache-pkg@1.0.0",
      bin: "slow-cache-wrong-hint",
    });
    expect(result).toMatch(/node_modules[\\/]\.bin[\\/]slow-cache-real$/);
  });

  it("swallows callback exceptions so a throwing subscriber doesn't abort the install", async () => {
    const fakeNpm = path.join(pathSandbox!, "npm");
    await writeExecutable(
      fakeNpm,
      "#!/bin/sh\nexport PATH=/bin:/usr/bin\nmkdir -p node_modules/.bin\ntouch node_modules/.bin/boom-bin\nchmod +x node_modules/.bin/boom-bin\nexit 0\n",
    );
    process.env.PATH = pathSandbox!;
    const binPath = await ensureNpmPackage({
      agentId: "throwing-pkg",
      version: "1.0.0",
      packageSpec: "throwing-pkg@1.0.0",
      bin: "boom-bin",
      onProgress: () => {
        throw new Error("subscriber boom");
      },
    });
    const st = await fs.stat(binPath);
    expect(st.isFile()).toBe(true);
  });
});

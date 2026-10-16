import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ensureNpmPackage, type NpmInstallProgress } from "./npm-install.js";
import { paths } from "./paths.js";
import { currentPlatformKey } from "./binary-install.js";
import { writeFakeCommand } from "../__tests__/test-utils.js";

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

  // A PATH containing the fake npm and nothing else that could resolve a
  // real one. On Windows it must still contain System32: spawning a .cmd
  // goes through a shell, and Node falls back to a bare "cmd.exe" that
  // PATH has to resolve. Replacing PATH outright made every fake-npm
  // test fail with ENOENT for cmd.exe rather than for npm, which read as
  // "npm not found" and hid the fact that npm.CMD had resolved fine.
  function sandboxedPath(): string {
    if (process.platform !== "win32") {
      return pathSandbox!;
    }
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    return [pathSandbox!, path.join(systemRoot, "System32")].join(path.delimiter);
  }

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
    process.env.PATH = sandboxedPath();
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
    await writeFakeCommand(
      pathSandbox!,
      "npm",
      `process.stderr.write("npm ERR! code EACCES\\n");
process.stderr.write("npm ERR! syscall mkdir\\n");
process.exit(243);
`,
    );
    process.env.PATH = sandboxedPath();

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
    await writeFakeCommand(
      pathSandbox!,
      "npm",
      `import { mkdirSync } from "node:fs";
mkdirSync("node_modules/.bin", { recursive: true });
`,
    );
    process.env.PATH = sandboxedPath();

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

  it("runs npm in a dir with its own package.json so npm can't resolve an ancestor project", async () => {
    await writeFakeCommand(
      pathSandbox!,
      "npm",
      `import { existsSync, mkdirSync, writeFileSync } from "node:fs";
if (!existsSync("package.json")) {
  process.stderr.write("no package.json in cwd\\n");
  process.exit(1);
}
mkdirSync("node_modules/.bin", { recursive: true });
writeFileSync("node_modules/.bin/rooted-bin", "", { mode: 0o755 });
`,
    );
    process.env.PATH = sandboxedPath();
    const binPath = await ensureNpmPackage({
      agentId: "rooted-pkg",
      version: "1.0.0",
      packageSpec: "rooted-pkg@1.0.0",
      bin: "rooted-bin",
    });
    const installDir = path.dirname(path.dirname(path.dirname(binPath)));
    await expect(
      fs.access(path.join(installDir, "package.json")),
    ).resolves.toBeUndefined();
  });

  it("emits install_start then installed via onProgress on a successful install", async () => {
    // Fake npm that creates the expected bin so ensureNpmPackage's
    // post-install check passes — we only care about the progress
    // event sequence here, not the actual install semantics.
    //
    // Absolute paths to mkdir/touch/chmod because the surrounding tests
    // set PATH to a single sandbox dir; without that, the shell builtin
    // lookup fails and the script silently produces nothing.
    await writeFakeCommand(
      pathSandbox!,
      "npm",
      `import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync("node_modules/.bin", { recursive: true });
writeFileSync("node_modules/.bin/progress-bin", "", { mode: 0o755 });
`,
    );
    process.env.PATH = sandboxedPath();
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
    await writeFakeCommand(
      pathSandbox!,
      "npm",
      `import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync("node_modules/.bin", { recursive: true });
mkdirSync("node_modules/@qwen-code/qwen-code", { recursive: true });
writeFileSync("node_modules/@qwen-code/qwen-code/package.json", '{"bin":{"qwen":"./cli.js"}}');
writeFileSync("node_modules/.bin/qwen", "", { mode: 0o755 });
`,
    );
    process.env.PATH = sandboxedPath();

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
    await writeFakeCommand(
      pathSandbox!,
      "npm",
      `import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync("node_modules/.bin", { recursive: true });
mkdirSync("node_modules/string-bin-pkg", { recursive: true });
writeFileSync("node_modules/string-bin-pkg/package.json", '{"bin":"./cli.js"}');
writeFileSync("node_modules/.bin/string-bin-pkg", "", { mode: 0o755 });
`,
    );
    process.env.PATH = sandboxedPath();

    const result = await ensureNpmPackage({
      agentId: "string-bin-pkg",
      version: "1.0.0",
      packageSpec: "string-bin-pkg@1.0.0",
      bin: "wrong-hint",
    });
    expect(result).toMatch(/node_modules[\\/]\.bin[\\/]string-bin-pkg$/);
  });

  it("picks matching key from a multi-bin package.json via basename", async () => {
    await writeFakeCommand(
      pathSandbox!,
      "npm",
      `import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync("node_modules/.bin", { recursive: true });
mkdirSync("node_modules/multi-tool", { recursive: true });
writeFileSync("node_modules/multi-tool/package.json", '{"bin":{"multi-tool":"./main.js","multi-tool-legacy":"./legacy.js"}}');
writeFileSync("node_modules/.bin/multi-tool", "", { mode: 0o755 });
writeFileSync("node_modules/.bin/multi-tool-legacy", "", { mode: 0o755 });
`,
    );
    process.env.PATH = sandboxedPath();

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
    await writeFakeCommand(
      pathSandbox!,
      "npm",
      `import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync("node_modules/.bin", { recursive: true });
mkdirSync("node_modules/ambiguous-pkg", { recursive: true });
writeFileSync("node_modules/ambiguous-pkg/package.json", '{"bin":{"foo":"./foo.js","bar":"./bar.js"}}');
writeFileSync("node_modules/.bin/foo", "", { mode: 0o755 });
writeFileSync("node_modules/.bin/bar", "", { mode: 0o755 });
`,
    );
    process.env.PATH = sandboxedPath();

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
    await writeFakeCommand(
      pathSandbox!,
      "npm",
      `import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync("node_modules/.bin", { recursive: true });
writeFileSync("node_modules/.bin/boom-bin", "", { mode: 0o755 });
`,
    );
    process.env.PATH = sandboxedPath();
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

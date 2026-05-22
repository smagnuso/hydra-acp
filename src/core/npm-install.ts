import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { paths } from "./paths.js";
import { currentPlatformKey } from "./binary-install.js";

// Where npm-install routes its human-readable progress lines. Mirrors
// binary-install's sink so the daemon can swap in pino routing on
// startup and `hydra logs` surfaces install progress.
export type NpmInstallLog = (message: string) => void;

let logSink: NpmInstallLog = (msg) => {
  process.stderr.write(msg + "\n");
};

export function setNpmInstallLogger(log: NpmInstallLog | null): void {
  logSink = log ?? ((msg) => process.stderr.write(msg + "\n"));
}

// Structured per-call progress for npm-distributed agents. npm runs in
// --silent mode and gives us no byte stream, so we only emit coarse
// start/done events — the TUI renders these as an indeterminate
// "Installing <agentId> via npm…" line rather than a percent bar.
export type NpmInstallProgress =
  | { phase: "install_start"; agentId: string; version: string; packageSpec: string }
  | { phase: "installed"; agentId: string; version: string };

export type NpmInstallProgressCallback = (event: NpmInstallProgress) => void;

export interface EnsureNpmPackageArgs {
  agentId: string;
  version: string;
  packageSpec: string;
  bin: string;
  registry?: string;
  onProgress?: NpmInstallProgressCallback;
}

// Ensure the npm package for an agent is installed at
// ~/.hydra-acp/agents/<platformKey>/<id>/<version>/node<ABI>/ and return
// the absolute path to its bin. Runs `npm install --prefix` once into a
// temp dir, then atomic-renames into place; subsequent calls short-circuit
// if the bin already exists.
//
// args.bin is a hint (registry-supplied or basename-derived). When the hint
// doesn't match the actual bin the package declares, resolveBin() reads the
// installed package.json and finds the right name before falling back to the
// basename heuristic.
export async function ensureNpmPackage(
  args: EnsureNpmPackageArgs,
): Promise<string> {
  const platformKey = currentPlatformKey();
  if (!platformKey) {
    throw new Error(
      `Agent ${args.agentId}: cannot determine platform key for ${process.platform}/${process.arch}`,
    );
  }
  const installDir = paths.agentNpmInstallDir(
    args.agentId,
    platformKey,
    args.version,
  );
  const packageName = packageNameFromSpec(args.packageSpec);
  const basename = packageBasename(packageName);
  const resolveArgs = { installDir, packageName, hint: args.bin, basename };

  // Fast-path: hint bin already on disk.
  const hintPath = path.join(installDir, "node_modules", ".bin", args.bin);
  if (await fileExists(hintPath))
    return hintPath;

  // Slow-path: install dir exists but hint doesn't match the real bin —
  // resolve from the installed package.json without re-running npm install.
  if (await fileExists(installDir)) {
    const slowResolved = await resolveBin(resolveArgs);
    if (slowResolved)
      return slowResolved.binPath;
  }

  await installInto({
    agentId: args.agentId,
    version: args.version,
    packageSpec: args.packageSpec,
    installDir,
    registry: args.registry,
    onProgress: args.onProgress,
  });

  const resolved = await resolveBin(resolveArgs);
  if (resolved)
    return resolved.binPath;

  const binField = await readPackageJsonBin(installDir, packageName);
  const declared =
    typeof binField === "object" && binField !== null
      ? Object.keys(binField)
      : typeof binField === "string"
        ? [basename]
        : [];
  const suffix =
    declared.length > 0
      ? ` (package declares bins: ${declared.join(", ")})`
      : "";
  throw new Error(
    `Agent ${args.agentId}: npm install of ${args.packageSpec} did not produce bin ${args.bin} (looked in ${installDir}/node_modules/.bin/)${suffix}`,
  );
}

async function installInto(args: {
  agentId: string;
  version: string;
  packageSpec: string;
  installDir: string;
  registry?: string;
  onProgress?: NpmInstallProgressCallback;
}): Promise<void> {
  await fsp.mkdir(path.dirname(args.installDir), { recursive: true });
  const tempDir = await fsp.mkdtemp(`${args.installDir}.partial-`);
  try {
    logSink(
      `hydra-acp: installing ${args.packageSpec} for ${args.agentId} into ${tempDir}`,
    );
    safeEmit(args.onProgress, {
      phase: "install_start",
      agentId: args.agentId,
      version: args.version,
      packageSpec: args.packageSpec,
    });
    await runNpmInstall({
      packageSpec: args.packageSpec,
      cwd: tempDir,
      registry: args.registry,
    });
    try {
      await fsp.rename(tempDir, args.installDir);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      // Race with another process: the other side already populated
      // installDir. Discard our copy and let the caller use the
      // now-existing install.
      if (
        (e.code === "EEXIST" || e.code === "ENOTEMPTY") &&
        (await fileExists(args.installDir))
      ) {
        await fsp.rm(tempDir, { recursive: true, force: true }).catch(
          () => undefined,
        );
        safeEmit(args.onProgress, {
          phase: "installed",
          agentId: args.agentId,
          version: args.version,
        });
        return;
      }
      throw err;
    }
    logSink(`hydra-acp: installed ${args.agentId} to ${args.installDir}`);
    safeEmit(args.onProgress, {
      phase: "installed",
      agentId: args.agentId,
      version: args.version,
    });
  } catch (err) {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(
      () => undefined,
    );
    throw err;
  }
}

function safeEmit(
  cb: NpmInstallProgressCallback | undefined,
  event: NpmInstallProgress,
): void {
  if (!cb) {
    return;
  }
  try {
    cb(event);
  } catch {
    // Progress callbacks are observational; a throwing subscriber
    // (e.g. a WS connection that closed) must not abort the install.
  }
}

// Retry budget for ETXTBSY ("text file busy") on exec. The kernel
// briefly refuses to execve a file whose inode has any outstanding
// writer fd, and on Linux under load that window can persist tens of
// milliseconds AFTER the writer has closed the fd (libuv worker
// thread close ops are not always synchronous w.r.t. inode
// bookkeeping). We retry with a small exponential backoff so a real
// user who just `npm update -g npm`-ed in another shell doesn't see
// a spurious failure either.
const ETXTBSY_RETRIES = 5;
const ETXTBSY_BACKOFF_MS = 25;

function runNpmInstall(args: {
  packageSpec: string;
  cwd: string;
  registry?: string;
}): Promise<void> {
  return runNpmInstallOnce(args, 0);
}

async function runNpmInstallOnce(
  args: { packageSpec: string; cwd: string; registry?: string },
  attempt: number,
): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => {
      const registryArgs = args.registry ? ["--registry", args.registry] : [];
      let child;
      try {
        child = spawn(
          "npm",
          [
            "install",
            "--no-audit",
            "--no-fund",
            "--silent",
            ...registryArgs,
            args.packageSpec,
          ],
          { cwd: args.cwd, stdio: ["ignore", "pipe", "pipe"] },
        );
      } catch (err) {
        reject(err);
        return;
      }
      let stderrTail = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        void chunk;
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-4096);
      });
      child.on("error", (err) => {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "ENOENT") {
          reject(
            new Error(
              `npm not found on PATH (install Node.js / npm, or use a binary-distributed agent)`,
            ),
          );
          return;
        }
        reject(err);
      });
      child.on("exit", (code, signal) => {
        if (code === 0) {
          resolve();
          return;
        }
        const reason =
          code !== null
            ? `exit code ${code}`
            : `signal ${signal ?? "unknown"}`;
        const tail = stderrTail.trim();
        reject(
          new Error(
            tail
              ? `npm install ${args.packageSpec} failed (${reason})\nstderr: ${tail}`
              : `npm install ${args.packageSpec} failed (${reason})`,
          ),
        );
      });
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ETXTBSY" && attempt < ETXTBSY_RETRIES) {
      await new Promise((r) =>
        setTimeout(r, ETXTBSY_BACKOFF_MS * (attempt + 1)),
      );
      return runNpmInstallOnce(args, attempt + 1);
    }
    throw err;
  }
}

function packageNameFromSpec(spec: string): string {
  // "@scope/name@1.2.3" → "@scope/name", "name@1.2.3" → "name"
  if (spec.startsWith("@")) {
    const slashIdx = spec.indexOf("/");
    if (slashIdx === -1)
      return spec;
    const rest = spec.slice(slashIdx + 1);
    const atIdx = rest.indexOf("@");
    if (atIdx === -1)
      return spec;
    return spec.slice(0, slashIdx + 1 + atIdx);
  }
  const atIdx = spec.indexOf("@");
  if (atIdx <= 0)
    return spec;
  return spec.slice(0, atIdx);
}

function packageBasename(packageName: string): string {
  const lastSlash = packageName.lastIndexOf("/");
  return lastSlash === -1 ? packageName : packageName.slice(lastSlash + 1);
}

async function readPackageJsonBin(
  installDir: string,
  packageName: string,
): Promise<string | Record<string, string> | undefined> {
  const pkgPath = path.join(
    installDir,
    "node_modules",
    packageName,
    "package.json",
  );
  try {
    const text = await fsp.readFile(pkgPath, "utf8");
    const pkg = JSON.parse(text) as { bin?: unknown };
    if (
      typeof pkg.bin === "string" ||
      (typeof pkg.bin === "object" && pkg.bin !== null && !Array.isArray(pkg.bin))
    )
      return pkg.bin as string | Record<string, string>;
    return undefined;
  } catch {
    return undefined;
  }
}

// Resolves the real bin name for an npm-installed agent. Tries (in order):
// the registry-supplied hint, a single-bin or matching-key from package.json,
// then the package basename. Returns undefined if nothing exists on disk.
async function resolveBin(args: {
  installDir: string;
  packageName: string;
  hint: string;
  basename: string;
}): Promise<{ binName: string; binPath: string } | undefined> {
  const binDir = path.join(args.installDir, "node_modules", ".bin");

  const hintPath = path.join(binDir, args.hint);
  if (await fileExists(hintPath))
    return { binName: args.hint, binPath: hintPath };

  const binField = await readPackageJsonBin(args.installDir, args.packageName);
  if (typeof binField === "object" && binField !== null) {
    const keys = Object.keys(binField);
    if (keys.length === 1) {
      const key = keys[0] as string;
      const p = path.join(binDir, key);
      if (await fileExists(p))
        return { binName: key, binPath: p };
    } else if (keys.length > 1) {
      for (const candidate of [args.hint, args.basename]) {
        if (keys.includes(candidate)) {
          const p = path.join(binDir, candidate);
          if (await fileExists(p))
            return { binName: candidate, binPath: p };
        }
      }
    }
  }

  if (args.basename !== args.hint) {
    const p = path.join(binDir, args.basename);
    if (await fileExists(p))
      return { binName: args.basename, binPath: p };
  }

  return undefined;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

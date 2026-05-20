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
  const binPath = path.join(installDir, "node_modules", ".bin", args.bin);
  if (await fileExists(binPath)) {
    return binPath;
  }
  await installInto({
    agentId: args.agentId,
    version: args.version,
    packageSpec: args.packageSpec,
    installDir,
    registry: args.registry,
    onProgress: args.onProgress,
  });
  if (!(await fileExists(binPath))) {
    throw new Error(
      `Agent ${args.agentId}: npm install of ${args.packageSpec} did not produce bin ${args.bin} (looked in ${installDir}/node_modules/.bin/)`,
    );
  }
  return binPath;
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

async function fileExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

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

export interface EnsureNpmPackageArgs {
  agentId: string;
  version: string;
  packageSpec: string;
  bin: string;
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
    packageSpec: args.packageSpec,
    installDir,
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
  packageSpec: string;
  installDir: string;
}): Promise<void> {
  await fsp.mkdir(path.dirname(args.installDir), { recursive: true });
  const tempDir = await fsp.mkdtemp(`${args.installDir}.partial-`);
  try {
    logSink(
      `hydra-acp: installing ${args.packageSpec} for ${args.agentId} into ${tempDir}`,
    );
    await runNpmInstall({
      packageSpec: args.packageSpec,
      cwd: tempDir,
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
        return;
      }
      throw err;
    }
    logSink(`hydra-acp: installed ${args.agentId} to ${args.installDir}`);
  } catch (err) {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(
      () => undefined,
    );
    throw err;
  }
}

function runNpmInstall(args: {
  packageSpec: string;
  cwd: string;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "npm",
      ["install", "--no-audit", "--no-fund", "--silent", args.packageSpec],
      {
        cwd: args.cwd,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderrTail = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      void chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-4096);
    });
    child.on("error", (err) => {
      const msg =
        (err as NodeJS.ErrnoException).code === "ENOENT"
          ? `npm not found on PATH (install Node.js / npm, or use a binary-distributed agent)`
          : err.message;
      reject(new Error(msg));
    });
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const reason =
        code !== null ? `exit code ${code}` : `signal ${signal ?? "unknown"}`;
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
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

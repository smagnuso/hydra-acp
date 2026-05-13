import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { paths } from "./paths.js";

export type PlatformKey =
  | "darwin-aarch64"
  | "darwin-x86_64"
  | "linux-aarch64"
  | "linux-x86_64"
  | "windows-aarch64"
  | "windows-x86_64";

export interface BinaryTarget {
  archive?: string;
  cmd?: string;
  args?: string[];
  env?: Record<string, string>;
}

export type BinaryDistribution = Partial<Record<PlatformKey, BinaryTarget>>;

export function currentPlatformKey(): PlatformKey | undefined {
  const osPart =
    process.platform === "darwin"
      ? "darwin"
      : process.platform === "linux"
        ? "linux"
        : process.platform === "win32"
          ? "windows"
          : undefined;
  const archPart =
    process.arch === "arm64"
      ? "aarch64"
      : process.arch === "x64"
        ? "x86_64"
        : undefined;
  if (!osPart || !archPart) {
    return undefined;
  }
  return `${osPart}-${archPart}` as PlatformKey;
}

export function pickBinaryTarget(
  distribution: BinaryDistribution,
  platformKey: PlatformKey | undefined = currentPlatformKey(),
): BinaryTarget | undefined {
  if (!platformKey) {
    return undefined;
  }
  return distribution[platformKey];
}

// Where binary-install routes its human-readable progress lines. Default
// goes to process.stderr — useful when planSpawn runs in the foreground
// CLI/shim. The daemon overrides this on startup so the same lines land
// in daemon.log via pino (and are visible through `hydra logs`).
export type BinaryInstallLog = (message: string) => void;

let logSink: BinaryInstallLog = (msg) => {
  process.stderr.write(msg + "\n");
};

export function setBinaryInstallLogger(log: BinaryInstallLog | null): void {
  logSink = log ?? ((msg) => process.stderr.write(msg + "\n"));
}

export interface EnsureBinaryArgs {
  agentId: string;
  version: string;
  target: BinaryTarget;
}

// Ensure the binary for an agent is present at
// ~/.hydra-acp/agents/<platformKey>/<id>/<version>/ and return the absolute
// path to its executable. Downloads + extracts the archive on first use;
// subsequent calls short-circuit if the cmd already exists.
export async function ensureBinary(args: EnsureBinaryArgs): Promise<string> {
  if (!args.target.archive) {
    throw new Error(
      `Agent ${args.agentId} has no archive URL for ${currentPlatformKey() ?? "this platform"}`,
    );
  }
  if (!args.target.cmd) {
    throw new Error(`Agent ${args.agentId} has no cmd in its binary target`);
  }
  const platformKey = currentPlatformKey();
  if (!platformKey) {
    throw new Error(
      `Agent ${args.agentId}: cannot determine platform key for ${process.platform}/${process.arch}`,
    );
  }
  const installDir = paths.agentInstallDir(
    args.agentId,
    platformKey,
    args.version,
  );
  const cmdPath = path.resolve(installDir, args.target.cmd);
  if (await fileExists(cmdPath)) {
    return cmdPath;
  }
  await downloadAndExtract({
    agentId: args.agentId,
    archiveUrl: args.target.archive,
    installDir,
  });
  if (!(await fileExists(cmdPath))) {
    throw new Error(
      `Agent ${args.agentId}: extracted archive did not contain ${args.target.cmd} (looked in ${installDir})`,
    );
  }
  if (process.platform !== "win32") {
    await fsp.chmod(cmdPath, 0o755).catch(() => undefined);
  }
  return cmdPath;
}

async function downloadAndExtract(args: {
  agentId: string;
  archiveUrl: string;
  installDir: string;
}): Promise<void> {
  await fsp.mkdir(path.dirname(args.installDir), { recursive: true });
  const tempDir = await fsp.mkdtemp(`${args.installDir}.partial-`);
  try {
    logSink(`hydra-acp: downloading ${args.agentId} from ${args.archiveUrl}`);
    const archivePath = await downloadTo({
      url: args.archiveUrl,
      dir: tempDir,
      agentId: args.agentId,
    });
    logSink(`hydra-acp: extracting ${args.agentId}`);
    await extract(archivePath, tempDir);
    await fsp.unlink(archivePath).catch(() => undefined);
    try {
      await fsp.rename(tempDir, args.installDir);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      // Race with another process: the other side won this install, so
      // discard our copy and let the caller use the now-existing dir.
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
    await fsp
      .rm(tempDir, { recursive: true, force: true })
      .catch(() => undefined);
    throw err;
  }
}

async function downloadTo(args: {
  url: string;
  dir: string;
  agentId: string;
}): Promise<string> {
  const filename = inferArchiveName(args.url);
  const dest = path.join(args.dir, filename);
  const response = await fetch(args.url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(
      `Failed to download ${args.url}: HTTP ${response.status} ${response.statusText}`,
    );
  }
  const total = Number(response.headers.get("content-length") ?? "0");
  const out = fs.createWriteStream(dest);
  const nodeStream = Readable.fromWeb(response.body as never);

  let received = 0;
  let lastEmit = Date.now();
  // Throttle to one progress line per 2s; chatty enough to feel live in
  // `hydra logs`, infrequent enough not to flood a 100MB+ download.
  const EMIT_INTERVAL_MS = 2000;
  nodeStream.on("data", (chunk: Buffer) => {
    received += chunk.length;
    const now = Date.now();
    if (now - lastEmit < EMIT_INTERVAL_MS) {
      return;
    }
    lastEmit = now;
    logSink(formatProgress(args.agentId, received, total));
  });

  await new Promise<void>((resolve, reject) => {
    nodeStream.on("error", reject);
    out.on("error", reject);
    out.on("finish", () => resolve());
    nodeStream.pipe(out);
  });
  logSink(formatProgress(args.agentId, received, total, /* done */ true));
  return dest;
}

function formatProgress(
  agentId: string,
  received: number,
  total: number,
  done = false,
): string {
  const rxMb = (received / 1_000_000).toFixed(1);
  if (total > 0) {
    const totalMb = (total / 1_000_000).toFixed(1);
    const pct = Math.min(100, Math.floor((received / total) * 100));
    const tag = done ? "downloaded" : "downloading";
    return `hydra-acp: ${tag} ${agentId} ${rxMb}/${totalMb} MB (${pct}%)`;
  }
  const tag = done ? "downloaded" : "downloading";
  return `hydra-acp: ${tag} ${agentId} ${rxMb} MB`;
}

function inferArchiveName(url: string): string {
  const u = new URL(url);
  const base = path.posix.basename(u.pathname);
  return base || "archive";
}

async function extract(archivePath: string, dest: string): Promise<void> {
  const lower = archivePath.toLowerCase();
  if (
    lower.endsWith(".tar.gz") ||
    lower.endsWith(".tgz") ||
    lower.endsWith(".tar")
  ) {
    await run("tar", ["-xf", archivePath, "-C", dest]);
    return;
  }
  if (lower.endsWith(".zip")) {
    if (await hasCommand("unzip")) {
      await run("unzip", ["-q", archivePath, "-d", dest]);
      return;
    }
    // Modern bsdtar/libarchive (default on macOS and Windows 10+) reads
    // zip; fall back so we don't require unzip on those platforms.
    await run("tar", ["-xf", archivePath, "-C", dest]);
    return;
  }
  throw new Error(`Unsupported archive format: ${archivePath}`);
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "ignore", "inherit"],
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${cmd} ${args.join(" ")} exited with ${code !== null ? `code ${code}` : `signal ${signal}`}`,
        ),
      );
    });
  });
}

async function hasCommand(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const finder = process.platform === "win32" ? "where" : "which";
    const child = spawn(finder, [name], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
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

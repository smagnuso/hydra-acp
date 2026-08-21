import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// Directory-scoped config: a `.hydra-acp.json` anywhere between the
// current directory and $HOME layers onto ~/.hydra-acp/config.json for
// THIS invocation only. Nearest file wins.
//
// ---------------------------------------------------------------------
// WHY IT IS CLIENT-ONLY
//
// The daemon is long-lived and per-machine; a directory config is
// per-invocation and per-cwd. Those can't be the same thing. So the
// overlay is resolved in the client process and never travels to the
// daemon, which means the split between "works here" and "silently does
// nothing" is not a matter of taste:
//
//   selection keys work    — defaultAgent is resolved client-side and sent
//                            as an explicit agentId on session/new
//   definition keys do not — config.agents is what the DAEMON resolves and
//                            spawns, and it read config.json at startup
//
// Nothing is blocked. Keys the daemon owns are merged like any other and
// simply have no effect, which is why they're reported (see
// DAEMON_OWNED_KEYS) rather than rejected. A warn list that goes stale
// costs a missing warning; an allowlist that goes stale silently drops a
// key that should have worked, which is the bug the list existed to
// prevent.
//
// The one key that genuinely re-points everything is `home`, because a
// daemon owns a whole HYDRA_ACP_HOME (pidfile, auth token, sessions,
// queue, agent installs) rather than a port. See applyDirectoryConfig.
// ---------------------------------------------------------------------

export const DIRECTORY_CONFIG_FILENAME = ".hydra-acp.json";

// Not a HydraConfig key. Re-roots HYDRA_ACP_HOME for this invocation,
// which is how you get a genuinely separate daemon for a directory tree.
export const HOME_KEY = "home";

// Depth cap on the upward walk. path.dirname terminates at the root on
// its own; this is a backstop against a pathological mount.
const MAX_WALK_DEPTH = 64;

// Top-level HydraConfig keys read by the daemon rather than the client.
// Merging one of these into a directory config parses fine and then does
// nothing, because the daemon never sees the overlay.
export const DAEMON_OWNED_KEYS: readonly string[] = [
  "agents",
  "agentOverrides",
  "registry",
  "npmRegistry",
  "extensions",
  "transformers",
  "defaultTransformers",
  "synopsisAgent",
  "synopsisModel",
  "compaction",
  "compressToolContent",
  "disableWorkspaceSnapshots",
];

export interface DirectoryConfigLayer {
  // Absolute path to the file, for diagnostics.
  file: string;
  data: Record<string, unknown>;
}

export interface DirectoryConfigNotice {
  file: string;
  key: string;
  message: string;
}

export interface AppliedDirectoryConfig {
  layers: DirectoryConfigLayer[];
  notices: DirectoryConfigNotice[];
  // Resolved absolute path when a layer set `home`, else undefined.
  home?: string;
}

function expandTilde(p: string): string {
  if (p === "~") {
    return os.homedir();
  }
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  if (p.startsWith("$HOME/")) {
    return path.join(os.homedir(), p.slice(6));
  }
  return p;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Objects merge, scalars and arrays replace, overlay wins. Same rule as
// config.agents `extends`, so there's one merge semantics to learn.
// Arrays replace rather than concatenate deliberately: appending to
// `defaultTransformers` from a parent directory is almost never what
// someone means by writing the key.
export function deepMergeConfig(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const existing = out[key];
    out[key] =
      isPlainObject(existing) && isPlainObject(value)
        ? deepMergeConfig(existing, value)
        : value;
  }
  return out;
}

// Collect every `.hydra-acp.json` from `cwd` up to and including
// `stopAt` (default $HOME), OUTERMOST FIRST so the caller can merge in
// order and let the nearest file win. Walking past $HOME is deliberate
// when cwd sits outside it — the walk ends at the filesystem root — so a
// directory config still works for trees mounted elsewhere.
//
// Unreadable or malformed files are skipped with a notice rather than
// thrown: a stray file shouldn't make hydra unusable in a directory.
export async function findDirectoryConfigs(
  cwd: string,
  stopAt: string = os.homedir(),
): Promise<{ layers: DirectoryConfigLayer[]; notices: DirectoryConfigNotice[] }> {
  const layers: DirectoryConfigLayer[] = [];
  const notices: DirectoryConfigNotice[] = [];
  const stop = path.resolve(stopAt);
  let dir = path.resolve(cwd);
  for (let depth = 0; depth < MAX_WALK_DEPTH; depth += 1) {
    const file = path.join(dir, DIRECTORY_CONFIG_FILENAME);
    let text: string | undefined;
    try {
      text = await fs.readFile(file, "utf8");
    } catch {
      text = undefined;
    }
    if (text !== undefined) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (isPlainObject(parsed)) {
          layers.push({ file, data: parsed });
        } else {
          notices.push({
            file,
            key: "",
            message: "expected a JSON object; ignoring this file",
          });
        }
      } catch (err) {
        notices.push({
          file,
          key: "",
          message: `is not valid JSON (${(err as Error).message}); ignoring this file`,
        });
      }
    }
    if (dir === stop) {
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  // Collected nearest-first; callers merge outermost-first.
  layers.reverse();
  return { layers, notices };
}

// Report keys that parse but can't take effect, so a directory config
// that quietly does nothing says so.
export function directoryConfigNotices(
  layers: readonly DirectoryConfigLayer[],
): DirectoryConfigNotice[] {
  const out: DirectoryConfigNotice[] = [];
  for (const layer of layers) {
    for (const key of Object.keys(layer.data)) {
      if (DAEMON_OWNED_KEYS.includes(key)) {
        out.push({
          file: layer.file,
          key,
          message: `\`${key}\` is read by the daemon, which loads config.json at startup, so it has no effect in a directory config`,
        });
      }
      if (key === "daemon") {
        out.push({
          file: layer.file,
          key,
          message:
            "`daemon` only changes which daemon this client dials; a daemon started from here still binds config.json's host/port. Use `home` for a separate daemon",
        });
      }
    }
  }
  return out;
}

// Process-wide overlay, installed once by the client entry point. Kept
// here rather than in config.ts so the dependency runs one way
// (config.ts imports this module, never the reverse).
let overlay: Record<string, unknown> | undefined;

export function currentDirectoryOverlay(): Record<string, unknown> | undefined {
  return overlay;
}

export function setDirectoryOverlay(
  next: Record<string, unknown> | undefined,
): void {
  overlay = next;
}

// Resolve and install the directory config for `cwd`. Must run before
// anything reads config or paths:
//
//   1. `home` re-roots HYDRA_ACP_HOME. paths.ts reads that env var on
//      every call and derives ~30 paths from it, so setting it here
//      re-points config.json, the auth token, sessions, the pidfile and
//      agent installs together. spawnDaemonDetached's scrubInheritedEnv()
//      preserves the variable, so an auto-started daemon lands in the
//      same home rather than binding the global one.
//   2. The remaining keys become the overlay that loadConfig() merges.
//
// `home` is consumed here and never reaches the merged config; it isn't
// a HydraConfig key.
export async function applyDirectoryConfig(
  cwd: string = process.cwd(),
): Promise<AppliedDirectoryConfig> {
  const { layers, notices } = await findDirectoryConfigs(cwd);
  notices.push(...directoryConfigNotices(layers));
  if (layers.length === 0) {
    setDirectoryOverlay(undefined);
    return { layers, notices };
  }

  let merged: Record<string, unknown> = {};
  for (const layer of layers) {
    merged = deepMergeConfig(merged, layer.data);
  }

  let home: string | undefined;
  const rawHome = merged[HOME_KEY];
  if (typeof rawHome === "string" && rawHome.length > 0) {
    // An explicitly exported HYDRA_ACP_HOME wins. Env beats config file by
    // convention, and more concretely: a directory config is ambient
    // (it applies to any cwd under it, including a temp dir something else
    // chose), while the env var is a deliberate per-invocation override.
    // vitest.setup.ts clamps HYDRA_ACP_HOME to a per-worker tmpdir
    // precisely so a test can never touch the real ~/.hydra-acp — letting
    // a stray `.hydra-acp.json` overwrite that would reopen exactly the
    // hole paths.ts's test-runner guard exists to close.
    const explicit = process.env.HYDRA_ACP_HOME;
    if (explicit && explicit.length > 0) {
      notices.push({
        file: layers[layers.length - 1]!.file,
        key: HOME_KEY,
        message: `\`home\` ignored: HYDRA_ACP_HOME is already set to ${explicit}`,
      });
    } else {
      home = path.resolve(expandTilde(rawHome));
      process.env.HYDRA_ACP_HOME = home;
    }
  } else if (rawHome !== undefined) {
    notices.push({
      file: layers[layers.length - 1]!.file,
      key: HOME_KEY,
      message: "`home` must be a non-empty string; ignoring it",
    });
  }
  delete merged[HOME_KEY];

  setDirectoryOverlay(Object.keys(merged).length > 0 ? merged : undefined);
  return { layers, notices, ...(home !== undefined ? { home } : {}) };
}

// Human-readable lines for the client to print on stderr.
export function formatDirectoryConfigNotices(
  notices: readonly DirectoryConfigNotice[],
): string[] {
  return notices.map((n) => `hydra-acp: ${n.file}: ${n.message}`);
}

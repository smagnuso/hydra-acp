import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as fs from "node:fs";

// Single source of truth for the hydra version: read once from the
// package.json nearest to this module on disk, at module-load time.
// Replaces the constellation of hardcoded "0.1.0" strings that
// previously stamped bundles, ACP handshakes, and the TUI clientInfo
// — those drifted from package.json as the version bumped.
function resolveVersion(): string {
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    // Walk a bounded number of parents. Both src/core/ (dev/test) and
    // dist/ (built) are at most a few levels deep inside the package
    // root; 8 is plenty and stops a stray run from trawling the FS.
    for (let i = 0; i < 8; i += 1) {
      const candidate = path.join(dir, "package.json");
      if (fs.existsSync(candidate)) {
        const pkg = JSON.parse(fs.readFileSync(candidate, "utf8")) as {
          name?: unknown;
          version?: unknown;
        };
        // Belt-and-suspenders: only accept package.json that names us,
        // so a freak nested monorepo layout can't shadow ours.
        if (
          typeof pkg.version === "string" &&
          pkg.version.length > 0 &&
          (typeof pkg.name !== "string" || pkg.name.includes("hydra-acp"))
        ) {
          return pkg.version;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  } catch {
    void 0;
  }
  return "0.0.0";
}

export const HYDRA_VERSION: string = resolveVersion();

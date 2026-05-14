import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { HYDRA_VERSION } from "./hydra-version.js";

describe("HYDRA_VERSION", () => {
  it("matches the version field of the package.json that owns this source", async () => {
    // Resolve the repo's package.json by walking up from this test
    // file the same way hydra-version.ts walks up from itself.
    const here = path.dirname(fileURLToPath(import.meta.url));
    let dir = here;
    let pkgVersion: string | undefined;
    for (let i = 0; i < 8; i += 1) {
      const candidate = path.join(dir, "package.json");
      try {
        const raw = await fs.readFile(candidate, "utf8");
        const pkg = JSON.parse(raw) as { name?: string; version?: string };
        if (pkg.name?.includes("hydra-acp")) {
          pkgVersion = pkg.version;
          break;
        }
      } catch {
        void 0;
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
    expect(pkgVersion).toBeTypeOf("string");
    expect(HYDRA_VERSION).toBe(pkgVersion);
  });

  it("is a non-empty semver-ish string (not the fallback 0.0.0)", () => {
    expect(HYDRA_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(HYDRA_VERSION).not.toBe("0.0.0");
  });
});

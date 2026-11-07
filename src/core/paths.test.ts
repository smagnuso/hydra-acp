import { describe, it, expect, afterEach, vi } from "vitest";
import { hydraHome, detectTestRunner, isPathInside, pathKey, samePath } from "./paths.js";
import { onPlatform } from "./platform-stub.js";
import * as path from "node:path";

describe("hydraHome test-runner guard", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("honours an explicit HYDRA_ACP_HOME override", () => {
    // Absolute is spelled differently per platform, and hydraHome()
    // resolves what it is given.
    const explicit = path.resolve(path.sep, "tmp", "explicit-home");
    vi.stubEnv("HYDRA_ACP_HOME", explicit);
    expect(hydraHome()).toBe(explicit);
  });

  it("throws (not real ~/.hydra-acp) when unset under vitest", () => {
    vi.stubEnv("HYDRA_ACP_HOME", "");
    expect(() => hydraHome()).toThrow(/test runner \(vitest\)/);
  });

  it("detects bun via process.versions.bun even when VITEST is absent", () => {
    vi.stubEnv("VITEST", "");
    const had = Object.prototype.hasOwnProperty.call(process.versions, "bun");
    const prev = (process.versions as { bun?: string }).bun;
    (process.versions as { bun?: string }).bun = "1.3.14";
    try {
      expect(detectTestRunner()).toBe("bun");
    } finally {
      if (had) {
        (process.versions as { bun?: string }).bun = prev;
      } else {
        delete (process.versions as { bun?: string }).bun;
      }
    }
  });

  it("compares paths ignoring separators and trailing slashes", () => {
    expect(samePath("/tmp/a/b", "/tmp/a/b/")).toBe(true);
    expect(samePath("/tmp/a/b", "/tmp/a/./b")).toBe(true);
    expect(samePath("/tmp/a/b", "/tmp/a/c")).toBe(false);
  });

  it("folds case only on Windows", () => {
    // probeDaemon compares the daemon's reported home against ours, so a
    // Zed-launched shim seeing `D:\Hydra` where the daemon recorded
    // `D:\hydra` must not read as a config mismatch. macOS is excluded
    // deliberately: it can be formatted case-sensitive.
    const folded = process.platform === "win32";
    expect(samePath("/tmp/Hydra", "/tmp/hydra")).toBe(folded);
  });

  it("detects jest and node:test runners", () => {
    const saved = {
      VITEST: process.env.VITEST,
      JEST_WORKER_ID: process.env.JEST_WORKER_ID,
      NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT,
    };
    try {
      delete process.env.VITEST;
      delete process.env.NODE_TEST_CONTEXT;
      process.env.JEST_WORKER_ID = "1";
      expect(detectTestRunner()).toBe("jest");
      delete process.env.JEST_WORKER_ID;
      process.env.NODE_TEST_CONTEXT = "child";
      expect(detectTestRunner()).toBe("node:test");
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = v;
        }
      }
    }
  });
});

describe("pathKey", () => {
  it("gives every Windows spelling of one directory the same key", async () => {
    await onPlatform("win32", () => {
      const keys = new Set(
        ["C:\\Users\\Sam\\proj", "c:\\users\\sam\\proj", "C:/Users/Sam/proj", "C:\\Users\\Sam\\proj\\", "C:/Users/Sam/proj/", "C:\\Users\\Sam\\.\\proj"].map(pathKey),
      );
      expect(keys.size).toBe(1);
    });
  });

  it("keeps different Windows directories apart", async () => {
    await onPlatform("win32", () => {
      expect(pathKey("C:\\proj")).not.toBe(pathKey("D:\\proj"));
      expect(pathKey("C:\\proj")).not.toBe(pathKey("C:\\proj2"));
      expect(pathKey("\\\\server\\share\\a")).not.toBe(pathKey("\\\\server\\share\\b"));
    });
  });

  it("keeps a drive root distinct from its bare-drive form", async () => {
    await onPlatform("win32", () => {
      expect(pathKey("C:\\")).toBe("c:\\");
    });
  });

  it("only drops trailing slashes off Windows, and stays case-sensitive", async () => {
    await onPlatform("linux", () => {
      expect(pathKey("/home/u/proj/")).toBe("/home/u/proj");
      expect(pathKey("/home/u/proj//")).toBe("/home/u/proj");
      expect(pathKey("/")).toBe("/");
      expect(pathKey("/Home/U")).not.toBe(pathKey("/home/u"));
      expect(pathKey("C:\\proj")).toBe("C:\\proj");
    });
  });
});

describe("isPathInside", () => {
  it("includes the directory itself and what lies beneath it", async () => {
    await onPlatform("win32", () => {
      expect(isPathInside("C:\\a\\b", "c:/a/b")).toBe(true);
      expect(isPathInside("C:\\a\\b\\c\\d.ts", "C:\\A\\B")).toBe(true);
    });
    await onPlatform("linux", () => {
      expect(isPathInside("/a/b", "/a/b/")).toBe(true);
      expect(isPathInside("/a/b/c/d.ts", "/a/b")).toBe(true);
    });
  });

  it("does not take a sibling that merely starts the same", async () => {
    await onPlatform("win32", () => {
      expect(isPathInside("C:\\work2\\x", "C:\\work")).toBe(false);
    });
    await onPlatform("linux", () => {
      expect(isPathInside("/workspaces/x", "/work")).toBe(false);
      expect(isPathInside("/A/b", "/a")).toBe(false);
    });
  });
});

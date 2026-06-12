import { describe, it, expect, afterEach, vi } from "vitest";
import { hydraHome, detectTestRunner } from "./paths.js";

describe("hydraHome test-runner guard", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("honours an explicit HYDRA_ACP_HOME override", () => {
    vi.stubEnv("HYDRA_ACP_HOME", "/tmp/explicit-home");
    expect(hydraHome()).toBe("/tmp/explicit-home");
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

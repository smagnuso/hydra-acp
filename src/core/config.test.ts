import { describe, it, expect } from "vitest";
import { generateAuthToken, defaultConfig } from "./config.js";

describe("generateAuthToken", () => {
  it("returns a hydra_token_-prefixed token with 32 hex bytes", () => {
    const token = generateAuthToken();
    expect(token.startsWith("hydra_token_")).toBe(true);
    const hex = token.slice("hydra_token_".length);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces different tokens on subsequent calls", () => {
    expect(generateAuthToken()).not.toBe(generateAuthToken());
  });
});

describe("defaultConfig", () => {
  it("emits a config that validates and includes a fresh token", () => {
    const cfg = defaultConfig();
    expect(cfg.daemon.authToken.startsWith("hydra_token_")).toBe(true);
    expect(cfg.daemon.host).toBe("127.0.0.1");
    expect(cfg.daemon.port).toBe(8765);
    expect(cfg.registry.url).toContain("agentclientprotocol.com");
  });
});

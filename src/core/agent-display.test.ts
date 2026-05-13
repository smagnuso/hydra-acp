import { describe, it, expect } from "vitest";
import { formatAgentWithModel, shortenModel } from "./agent-display.js";

describe("shortenModel", () => {
  it("strips the provider prefix", () => {
    expect(shortenModel("openai/gpt-4o-mini")).toBe("gpt-4o-mini");
    expect(shortenModel("ncp-anthropic/claude-opus-4-7")).toBe(
      "claude-opus-4-7",
    );
  });

  it("returns ids without a slash unchanged", () => {
    expect(shortenModel("claude-sonnet")).toBe("claude-sonnet");
  });

  it("returns undefined for undefined/empty", () => {
    expect(shortenModel(undefined)).toBeUndefined();
    expect(shortenModel("")).toBeUndefined();
  });
});

describe("formatAgentWithModel", () => {
  it("combines agent and shortened model in parens", () => {
    expect(formatAgentWithModel("opencode", "openai/gpt-5-codex")).toBe(
      "opencode(gpt-5-codex)",
    );
  });

  it("returns just the agent when model is unknown", () => {
    expect(formatAgentWithModel("opencode", undefined)).toBe("opencode");
    expect(formatAgentWithModel("opencode", "")).toBe("opencode");
  });

  it("returns '?' when both are missing", () => {
    expect(formatAgentWithModel(undefined, undefined)).toBe("?");
  });
});

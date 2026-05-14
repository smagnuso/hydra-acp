import { describe, it, expect } from "vitest";
import {
  formatAgentCell,
  formatAgentWithModel,
  formatCost,
  shortenModel,
} from "./agent-display.js";

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
  it("joins agent and shortened model with a bullet (no spaces)", () => {
    expect(formatAgentWithModel("opencode", "openai/gpt-5-codex")).toBe(
      "opencode•gpt-5-codex",
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

describe("formatCost", () => {
  it("renders USD with a $ sign and 2 decimals when >= $1", () => {
    expect(formatCost(1.234, "USD")).toBe("$1.23");
    expect(formatCost(42, undefined)).toBe("$42.00");
  });

  it("uses 4 decimals for sub-dollar amounts so they don't round to zero", () => {
    expect(formatCost(0.0042, "USD")).toBe("$0.0042");
    expect(formatCost(0.0042, undefined)).toBe("$0.0042");
  });

  it("renders non-USD currencies with the code suffixed", () => {
    expect(formatCost(1.5, "EUR")).toBe("1.50 EUR");
  });
});

describe("formatAgentCell", () => {
  it("appends whole-dollar cost when present and >= $0.50", () => {
    expect(
      formatAgentCell("opencode", {
        costAmount: 1.42,
        costCurrency: "USD",
      }),
    ).toBe("opencode $1");
    expect(
      formatAgentCell("opencode", { costAmount: 53.12 }),
    ).toBe("opencode $53");
  });

  it("rounds to nearest dollar", () => {
    expect(formatAgentCell("opencode", { costAmount: 5.6 })).toBe("opencode $6");
  });

  it("omits the cost suffix entirely when it rounds to zero", () => {
    expect(formatAgentCell("opencode", { costAmount: 0.42 })).toBe("opencode");
    expect(formatAgentCell("opencode", { costAmount: 0.0042 })).toBe("opencode");
  });

  it("falls back to bare agent id when no cost is present", () => {
    expect(formatAgentCell("opencode", undefined)).toBe("opencode");
    expect(formatAgentCell("opencode", {})).toBe("opencode");
  });

  it("renders '?' when the agent id is missing", () => {
    expect(formatAgentCell(undefined, { costAmount: 2.1 })).toBe("? $2");
  });

  it("renders non-USD currencies without a $ sign", () => {
    expect(
      formatAgentCell("opencode", {
        costAmount: 5.6,
        costCurrency: "EUR",
      }),
    ).toBe("opencode 6 EUR");
  });
});

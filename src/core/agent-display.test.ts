import { describe, it, expect } from "vitest";
import {
  formatAgentCell,
  formatAgentWithModel,
  formatCost,
  formatCostCell,
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

  it("caps at cents (2 decimals) for sub-dollar amounts", () => {
    expect(formatCost(0.0042, "USD")).toBe("$0.00");
    expect(formatCost(0.1114, undefined)).toBe("$0.11");
  });

  it("renders non-USD currencies with the code suffixed", () => {
    expect(formatCost(1.5, "EUR")).toBe("1.50 EUR");
  });
});

describe("formatAgentCell", () => {
  it("returns the bare agent id (cost now lives in its own column)", () => {
    expect(formatAgentCell("opencode")).toBe("opencode");
  });

  it("renders '?' when the agent id is missing", () => {
    expect(formatAgentCell(undefined)).toBe("?");
  });
});

describe("formatCostCell", () => {
  it("renders whole-dollar USD (cents dropped)", () => {
    expect(formatCostCell({ costAmount: 1.42, costCurrency: "USD" })).toBe("$1");
    expect(formatCostCell({ costAmount: 53.7 })).toBe("$54");
  });

  it("rounds sub-dollar amounts to the nearest dollar", () => {
    expect(formatCostCell({ costAmount: 0.42 })).toBe("$0");
    expect(formatCostCell({ costAmount: 0.6 })).toBe("$1");
  });

  it("renders non-USD with two decimals and the currency code", () => {
    expect(formatCostCell({ costAmount: 5.6, costCurrency: "EUR" })).toBe(
      "5.60 EUR",
    );
  });

  it("renders an empty string when there's no cost data", () => {
    expect(formatCostCell(undefined)).toBe("");
    expect(formatCostCell({})).toBe("");
  });
});

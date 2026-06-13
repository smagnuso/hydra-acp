import { describe, it, expect } from "vitest";
import { resolveCandidate, resolveModelId } from "./model-resolve.js";
import type { AdvertisedModel } from "./hydra-commands.js";

const models = (...ids: string[]): AdvertisedModel[] =>
  ids.map((modelId) => ({ modelId }));

describe("resolveModelId", () => {
  it("returns 'none' when the agent advertised no models", () => {
    expect(resolveModelId("claude-opus-4-7", [])).toEqual({
      kind: "none",
      requested: "claude-opus-4-7",
    });
  });

  it("returns 'exact' when the requested id is advertised verbatim", () => {
    const res = resolveModelId(
      "anthropic/claude-opus-4-7",
      models("anthropic/claude-opus-4-7", "anthropic/claude-opus-4-8"),
    );
    expect(res).toEqual({ kind: "exact", modelId: "anthropic/claude-opus-4-7" });
  });

  it("resolves a bare id to the single provider-prefixed advertised id", () => {
    const res = resolveModelId(
      "claude-opus-4-7",
      models(
        "anthropic/claude-opus-4-7",
        "anthropic/claude-opus-4-8",
        "openai/gpt-5",
      ),
    );
    expect(res).toEqual({
      kind: "resolved",
      modelId: "anthropic/claude-opus-4-7",
      requested: "claude-opus-4-7",
    });
  });

  it("resolves a differently-prefixed id by trailing segment", () => {
    const res = resolveModelId(
      "ncp-anthropic/claude-opus-4-7",
      models("anthropic/claude-opus-4-7"),
    );
    expect(res).toEqual({
      kind: "resolved",
      modelId: "anthropic/claude-opus-4-7",
      requested: "ncp-anthropic/claude-opus-4-7",
    });
  });

  it("is case-insensitive on the trailing segment", () => {
    const res = resolveModelId(
      "Claude-Opus-4-7",
      models("anthropic/claude-opus-4-7"),
    );
    expect(res).toMatchObject({ kind: "resolved", modelId: "anthropic/claude-opus-4-7" });
  });

  it("reports 'ambiguous' when several advertised ids share the trailing segment", () => {
    const res = resolveModelId(
      "claude-opus-4-7",
      models("anthropic/claude-opus-4-7", "ncp-anthropic/claude-opus-4-7"),
    );
    expect(res).toEqual({
      kind: "ambiguous",
      requested: "claude-opus-4-7",
      candidates: ["anthropic/claude-opus-4-7", "ncp-anthropic/claude-opus-4-7"],
    });
  });

  it("prefers an exact match even when the trailing segment is ambiguous", () => {
    const res = resolveModelId(
      "anthropic/claude-opus-4-7",
      models("anthropic/claude-opus-4-7", "ncp-anthropic/claude-opus-4-7"),
    );
    expect(res).toEqual({ kind: "exact", modelId: "anthropic/claude-opus-4-7" });
  });

  it("returns 'unknown' when no exact or trailing-segment match exists", () => {
    const res = resolveModelId(
      "claude-opus-4-9",
      models("anthropic/claude-opus-4-7", "anthropic/claude-opus-4-8"),
    );
    expect(res).toEqual({ kind: "unknown", requested: "claude-opus-4-9" });
  });

  it("does not partial-match by trailing segment alone", () => {
    // "gpt-5" doesn't trailing-segment-match "gpt-5-mini" — segment
    // equality, not substring. It DOES fall through to the substring
    // tier, where it hits both "gpt-5-mini" and "gpt-5-nano" → ambiguous.
    const res = resolveModelId("gpt-5", models("openai/gpt-5-mini", "openai/gpt-5-nano"));
    expect(res).toEqual({
      kind: "ambiguous",
      requested: "gpt-5",
      candidates: ["openai/gpt-5-mini", "openai/gpt-5-nano"],
    });
  });

  it("substring-resolves an unambiguous fragment", () => {
    const res = resolveModelId(
      "sonnet-4-6",
      models("ncp-anthropic/claude-sonnet-4-6", "ncp-anthropic/claude-opus-4-7"),
    );
    expect(res).toEqual({
      kind: "resolved",
      modelId: "ncp-anthropic/claude-sonnet-4-6",
      requested: "sonnet-4-6",
    });
  });

  it("substring tier reports ambiguous when several ids contain the fragment", () => {
    const res = resolveModelId(
      "sonnet",
      models("ncp-anthropic/claude-sonnet-4-5-20250929", "ncp-anthropic/claude-sonnet-4-6"),
    );
    expect(res).toEqual({
      kind: "ambiguous",
      requested: "sonnet",
      candidates: [
        "ncp-anthropic/claude-sonnet-4-5-20250929",
        "ncp-anthropic/claude-sonnet-4-6",
      ],
    });
  });

  it("substring tier is case-insensitive", () => {
    const res = resolveModelId(
      "SONNET-4-6",
      models("ncp-anthropic/claude-sonnet-4-6", "ncp-anthropic/claude-opus-4-7"),
    );
    expect(res).toMatchObject({
      kind: "resolved",
      modelId: "ncp-anthropic/claude-sonnet-4-6",
    });
  });
});

describe("resolveCandidate", () => {
  it("exact-matches a slash-free value", () => {
    const res = resolveCandidate("build", ["build", "plan", "chat"]);
    expect(res).toEqual({ kind: "exact", modelId: "build" });
  });

  it("substring-resolves a slash-free fragment", () => {
    const res = resolveCandidate("plan", ["build", "planning", "chat"]);
    expect(res).toEqual({ kind: "resolved", modelId: "planning", requested: "plan" });
  });

  it("returns 'unknown' when no candidate contains the query", () => {
    const res = resolveCandidate("zzz", ["build", "plan"]);
    expect(res).toEqual({ kind: "unknown", requested: "zzz" });
  });
});

import { describe, it, expect } from "vitest";
import { resolveModelId } from "./model-resolve.js";
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

  it("does not match a partial trailing segment", () => {
    // "gpt-5" must not resolve to "gpt-5-mini" — segment equality, not substring.
    const res = resolveModelId("gpt-5", models("openai/gpt-5-mini", "openai/gpt-5-nano"));
    expect(res).toEqual({ kind: "unknown", requested: "gpt-5" });
  });
});

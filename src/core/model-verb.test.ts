import { describe, it, expect, vi } from "vitest";
import {
  MODEL_VERB_SET_CONFIG_OPTION,
  MODEL_VERB_SET_MODEL,
  inferModelVerbFromResult,
  inferModelVerbFromUpdate,
  isMethodNotFound,
  modelChangeParams,
  requestModelChange,
} from "./model-verb.js";
import { JsonRpcErrorCodes } from "../acp/types-jsonrpc.js";

function rpcErr(code: number, message = "boom"): Error & { code: number } {
  const err = new Error(message) as Error & { code: number };
  err.code = code;
  return err;
}

describe("modelChangeParams", () => {
  it("builds the set_model envelope", () => {
    expect(modelChangeParams(MODEL_VERB_SET_MODEL, "s1", "m1")).toEqual({
      sessionId: "s1",
      modelId: "m1",
    });
  });

  it("builds the set_config_option envelope with configId=model", () => {
    expect(modelChangeParams(MODEL_VERB_SET_CONFIG_OPTION, "s1", "m1")).toEqual({
      sessionId: "s1",
      configId: "model",
      value: "m1",
    });
  });

  it("carries passthrough fields but strips verb-specific keys", () => {
    expect(
      modelChangeParams(MODEL_VERB_SET_CONFIG_OPTION, "s1", "m1", {
        sessionId: "stale",
        modelId: "stale",
        configId: "stale",
        value: "stale",
        _meta: { keep: true },
      }),
    ).toEqual({
      sessionId: "s1",
      configId: "model",
      value: "m1",
      _meta: { keep: true },
    });
  });
});

describe("inferModelVerbFromResult", () => {
  // Legacy shape: claude-acp / codex-acp / opencode nest the list under
  // `models`, spec-strict agents put it at the top level.
  it("infers set_model from a nested models.availableModels", () => {
    expect(
      inferModelVerbFromResult({
        sessionId: "u1",
        models: { currentModelId: "m1", availableModels: [{ modelId: "m1" }] },
      }),
    ).toBe(MODEL_VERB_SET_MODEL);
  });

  it("infers set_model from a top-level availableModels", () => {
    expect(
      inferModelVerbFromResult({ availableModels: [{ modelId: "m1" }] }),
    ).toBe(MODEL_VERB_SET_MODEL);
  });

  it("infers set_model from a foreign _meta namespace", () => {
    expect(
      inferModelVerbFromResult({
        _meta: { "some-agent": { availableModels: [{ modelId: "m1" }] } },
      }),
    ).toBe(MODEL_VERB_SET_MODEL);
  });

  // Modern shape (SDK 0.26+/1.x): availableModels doesn't exist in the
  // schema at all; the model lives in configOptions.
  it("infers set_config_option from configOptions[id=model]", () => {
    expect(
      inferModelVerbFromResult({
        sessionId: "u1",
        configOptions: [
          { id: "thought_level", currentValue: "medium", options: [] },
          { id: "model", currentValue: "m1", options: [{ value: "m1" }] },
        ],
      }),
    ).toBe(MODEL_VERB_SET_CONFIG_OPTION);
  });

  it("prefers the availableModels shape when an agent emits both", () => {
    expect(
      inferModelVerbFromResult({
        models: { availableModels: [{ modelId: "m1" }] },
        configOptions: [{ id: "model", currentValue: "m1", options: [] }],
      }),
    ).toBe(MODEL_VERB_SET_MODEL);
  });

  it("returns undefined when no model advertisement is present", () => {
    expect(inferModelVerbFromResult({ sessionId: "u1" })).toBeUndefined();
    expect(
      inferModelVerbFromResult({ configOptions: [{ id: "mode", options: [] }] }),
    ).toBeUndefined();
    expect(inferModelVerbFromResult(undefined)).toBeUndefined();
  });

  it("ignores hydra's own _meta namespace", () => {
    expect(
      inferModelVerbFromResult({
        _meta: { "hydra-acp": { availableModels: [{ modelId: "m1" }] } },
      }),
    ).toBeUndefined();
  });
});

describe("inferModelVerbFromUpdate", () => {
  it("infers set_model from current_model_update", () => {
    expect(
      inferModelVerbFromUpdate({ sessionUpdate: "_hydra_current_model_update", currentModel: "m1" }),
    ).toBe(MODEL_VERB_SET_MODEL);
  });

  it("infers set_config_option from a config_option_update carrying a model entry", () => {
    expect(
      inferModelVerbFromUpdate({
        sessionUpdate: "config_option_update",
        configOptions: [{ id: "model", currentValue: "m1", options: [] }],
      }),
    ).toBe(MODEL_VERB_SET_CONFIG_OPTION);
  });

  it("returns undefined for unrelated updates", () => {
    expect(
      inferModelVerbFromUpdate({
        sessionUpdate: "config_option_update",
        configOptions: [{ id: "thought_level", options: [] }],
      }),
    ).toBeUndefined();
    expect(inferModelVerbFromUpdate({ sessionUpdate: "agent_message_chunk" })).toBeUndefined();
    expect(inferModelVerbFromUpdate(undefined)).toBeUndefined();
  });
});

describe("isMethodNotFound", () => {
  it("matches -32601 only", () => {
    expect(isMethodNotFound(rpcErr(JsonRpcErrorCodes.MethodNotFound))).toBe(true);
    expect(isMethodNotFound(rpcErr(JsonRpcErrorCodes.InvalidParams))).toBe(false);
    expect(isMethodNotFound(new Error("no code"))).toBe(false);
    expect(isMethodNotFound(undefined)).toBe(false);
  });
});

describe("requestModelChange", () => {
  it("uses session/set_model by default and doesn't probe when it works", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true });
    const outcome = await requestModelChange({
      request,
      sessionId: "s1",
      modelId: "anthropic/claude-opus-4-7",
    });
    expect(outcome).toEqual({ verb: MODEL_VERB_SET_MODEL, result: { ok: true } });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("session/set_model", {
      sessionId: "s1",
      modelId: "anthropic/claude-opus-4-7",
    });
  });

  // The pi-acp case: @agentclientprotocol/sdk >= 0.26 dropped
  // session/set_model from its dispatch table.
  it("falls back to session/set_config_option on MethodNotFound", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(
        rpcErr(JsonRpcErrorCodes.MethodNotFound, '"Method not found": session/set_model'),
      )
      .mockResolvedValueOnce({ configOptions: [] });
    const outcome = await requestModelChange({
      request,
      sessionId: "s1",
      modelId: "anthropic/claude-fable-5",
    });
    expect(outcome.verb).toBe(MODEL_VERB_SET_CONFIG_OPTION);
    expect(outcome.result).toEqual({ configOptions: [] });
    expect(request).toHaveBeenNthCalledWith(2, "session/set_config_option", {
      sessionId: "s1",
      configId: "model",
      value: "anthropic/claude-fable-5",
    });
  });

  it("probes in the other direction when told to lead with set_config_option", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(rpcErr(JsonRpcErrorCodes.MethodNotFound))
      .mockResolvedValueOnce(null);
    const outcome = await requestModelChange({
      request,
      sessionId: "s1",
      modelId: "m1",
      verb: MODEL_VERB_SET_CONFIG_OPTION,
    });
    expect(outcome.verb).toBe(MODEL_VERB_SET_MODEL);
    expect(request).toHaveBeenNthCalledWith(1, "session/set_config_option", {
      sessionId: "s1",
      configId: "model",
      value: "m1",
    });
    expect(request).toHaveBeenNthCalledWith(2, "session/set_model", {
      sessionId: "s1",
      modelId: "m1",
    });
  });

  it("does not probe on non-MethodNotFound errors", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(rpcErr(JsonRpcErrorCodes.InvalidParams, "bad model id"));
    await expect(
      requestModelChange({ request, sessionId: "s1", modelId: "nope" }),
    ).rejects.toThrow("bad model id");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rethrows the original error when neither verb exists", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(
        rpcErr(JsonRpcErrorCodes.MethodNotFound, '"Method not found": session/set_model'),
      )
      .mockRejectedValueOnce(
        rpcErr(
          JsonRpcErrorCodes.MethodNotFound,
          '"Method not found": session/set_config_option',
        ),
      );
    await expect(
      requestModelChange({ request, sessionId: "s1", modelId: "m1" }),
    ).rejects.toThrow('"Method not found": session/set_model');
  });

  it("surfaces the fallback's own error when it fails for a different reason", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(rpcErr(JsonRpcErrorCodes.MethodNotFound))
      .mockRejectedValueOnce(rpcErr(JsonRpcErrorCodes.InvalidParams, "unknown config option"));
    await expect(
      requestModelChange({ request, sessionId: "s1", modelId: "m1" }),
    ).rejects.toThrow("unknown config option");
  });
});

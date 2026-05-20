import { describe, expect, it } from "vitest";
import { parseReattachResponse } from "./reconnect-state.js";

describe("parseReattachResponse", () => {
  it("extracts both fields from a well-formed response", () => {
    const result = parseReattachResponse({
      historyPolicy: "after_message",
      clientId: "cli_tDM9NI-c",
      sessionId: "hydra_session_CIUqaezbIPSBMSUG",
    });
    expect(result).toEqual({
      appliedPolicy: "after_message",
      clientId: "cli_tDM9NI-c",
    });
  });

  it("returns empty object for non-object input", () => {
    expect(parseReattachResponse(null)).toEqual({});
    expect(parseReattachResponse(undefined)).toEqual({});
    expect(parseReattachResponse("nope")).toEqual({});
    expect(parseReattachResponse(42)).toEqual({});
  });

  it("omits clientId when missing — caller keeps the prior value", () => {
    const result = parseReattachResponse({ historyPolicy: "full" });
    expect(result).toEqual({ appliedPolicy: "full" });
    expect(result.clientId).toBeUndefined();
  });

  it("omits clientId when not a string", () => {
    const result = parseReattachResponse({
      historyPolicy: "after_message",
      clientId: 123,
    });
    expect(result.clientId).toBeUndefined();
    expect(result.appliedPolicy).toBe("after_message");
  });

  it("omits clientId when empty string — defensive against degenerate daemons", () => {
    const result = parseReattachResponse({
      historyPolicy: "full",
      clientId: "",
    });
    expect(result.clientId).toBeUndefined();
  });

  it("omits appliedPolicy when historyPolicy is not a string", () => {
    const result = parseReattachResponse({
      historyPolicy: null,
      clientId: "cli_abc",
    });
    expect(result.appliedPolicy).toBeUndefined();
    expect(result.clientId).toBe("cli_abc");
  });

  // Regression: on a transparent reconnect the daemon mints a fresh
  // clientId. Before this helper landed, app.ts's onReconnect parsed
  // only historyPolicy, leaving ownClientId stale. The result was that
  // prompt_queue_added events for own-originated prompts were no longer
  // recognized as own, so the FIFO never popped — typed prompts never
  // echoed to scrollback and the agent reply appeared to come out of
  // nowhere. This test pins the exact field shape so a regression in
  // either direction (daemon stops sending clientId, or helper drops
  // it) fails loudly.
  it("regression: reconnect responses carry the fresh clientId", () => {
    const oldClientId = "cli_HjjN8ISU";
    const newClientId = "cli_tDM9NI-c";
    const result = parseReattachResponse({
      sessionId: "hydra_session_CIUqaezbIPSBMSUG",
      historyPolicy: "after_message",
      clientId: newClientId,
    });
    expect(result.clientId).toBe(newClientId);
    expect(result.clientId).not.toBe(oldClientId);
  });
});

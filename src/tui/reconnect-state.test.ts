import { describe, expect, it } from "vitest";
import {
  computeAttachReconcile,
  parseReattachResponse,
  shouldDriftSnap,
} from "./reconnect-state.js";

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

describe("shouldDriftSnap", () => {
  const baseline = {
    pendingTurns: 1,
    queueSize: 0,
    ownTurnInFlight: false,
    hasInFlightHead: false,
    replayDraining: false,
    amended: false,
  } as const;

  it("snaps when local accounting says busy but no live signal agrees", () => {
    expect(shouldDriftSnap(baseline)).toBe(true);
  });

  it("does not snap when pendingTurns is already 0", () => {
    expect(shouldDriftSnap({ ...baseline, pendingTurns: 0 })).toBe(false);
  });

  it("does not snap when a queued prompt is waiting", () => {
    expect(shouldDriftSnap({ ...baseline, queueSize: 1 })).toBe(false);
  });

  it("does not snap when this TUI has its own prompt in flight", () => {
    expect(shouldDriftSnap({ ...baseline, ownTurnInFlight: true })).toBe(false);
  });

  it("does not snap when an in-flight head messageId is tracked", () => {
    expect(shouldDriftSnap({ ...baseline, hasInFlightHead: true })).toBe(false);
  });

  // Regression: before this gate, replaying a historical turn_complete
  // during the attach drain snapped pendingTurns to 0 even though the
  // most recent prompt_received in history hadn't been paired yet. The
  // banner stayed "ready" through the entire still-open turn. See
  // session hydra_session_TMBdL4qgzQrSisPG, 2026-05-27.
  it("regression: never snaps while replay-draining", () => {
    expect(shouldDriftSnap({ ...baseline, replayDraining: true })).toBe(false);
    // All four other conditions met, only the replay flag flipped.
    expect(
      shouldDriftSnap({
        pendingTurns: 1,
        queueSize: 0,
        ownTurnInFlight: false,
        hasInFlightHead: false,
        replayDraining: true,
        amended: false,
      }),
    ).toBe(false);
  });

  // Regression: amending an amendment (or any in-flight turn this TUI
  // didn't start via runPrompt) fires a synthesized amend-cancel
  // turn_complete while turnInFlight is null, the replacement's chip
  // paint is still deferred (queueCache empty), and currentHeadMessageId
  // was just cleared — so every other signal looks idle. Before the
  // `amended` gate the snap zeroed pendingTurns and the banner sat on
  // "ready" for the entire replacement turn even though the agent was
  // mid-turn with an active plan. See session
  // hydra_session_VoEhR2QbnOCdk8Um, 2026-05-29.
  it("regression: never snaps on an amend-cancel turn_complete", () => {
    expect(shouldDriftSnap({ ...baseline, amended: true })).toBe(false);
    // Every other condition met (the amend-of-an-amendment shape), only
    // the amended flag holds the snap off.
    expect(
      shouldDriftSnap({
        pendingTurns: 2,
        queueSize: 0,
        ownTurnInFlight: false,
        hasInFlightHead: false,
        replayDraining: false,
        amended: true,
      }),
    ).toBe(false);
  });
});

describe("computeAttachReconcile", () => {
  it("daemon busy + local idle → bumps pendingTurns and goes busy", () => {
    const ts = 1_700_000_000_000;
    expect(
      computeAttachReconcile({ daemonTurnStartedAt: ts, pendingTurns: 0 }),
    ).toEqual({ pendingTurnsDelta: 1, banner: "busy", busySince: ts });
  });

  it("daemon busy + local busy → keeps pendingTurns, seeds busySince", () => {
    const ts = 1_700_000_000_000;
    expect(
      computeAttachReconcile({ daemonTurnStartedAt: ts, pendingTurns: 2 }),
    ).toEqual({ pendingTurnsDelta: 0, banner: "busy", busySince: ts });
  });

  it("daemon idle + local busy → snaps pendingTurns down, goes ready", () => {
    expect(
      computeAttachReconcile({ daemonTurnStartedAt: undefined, pendingTurns: 3 }),
    ).toEqual({ pendingTurnsDelta: -3, banner: "ready" });
  });

  it("daemon idle + local idle → no change, ready", () => {
    expect(
      computeAttachReconcile({ daemonTurnStartedAt: undefined, pendingTurns: 0 }),
    ).toEqual({ pendingTurnsDelta: 0, banner: "ready" });
  });

  // Regression: a WS disconnect mid-turn rejects the originator's
  // in-flight session/prompt request, runPrompt's finally drives
  // pendingTurns back to 0, and the post-reconnect reconcile used to
  // ignore the daemon's still-defined turnStartedAt — leaving the banner
  // on "ready" through the agent's continued streaming. See session
  // hydra_session_qVcKQN67lY6fuNXk, 2026-05-27.
  it("regression: WS-drop bumps pendingTurns back when daemon is still busy", () => {
    const ts = 1_700_000_123_456;
    const result = computeAttachReconcile({
      daemonTurnStartedAt: ts,
      pendingTurns: 0,
    });
    expect(result.pendingTurnsDelta).toBe(1);
    expect(result.banner).toBe("busy");
    expect(result.busySince).toBe(ts);
  });
});

import { describe, expect, it } from "vitest";

import { classifyPromptOrigin } from "./turn-origin.js";

describe("classifyPromptOrigin", () => {
  it("reads a resolved peer session as a peer, titled", () => {
    expect(
      classifyPromptOrigin({
        clientId: "cli_abc",
        name: "hydra-acp-cat",
        fromSession: "hydra_session_PEER",
        fromSessionTitle: "fix flaky test",
        depth: 1,
      }),
    ).toEqual({ origin: "peer", label: "fix flaky test" });
  });

  it("prefers the looked-up title over the sender's own label", () => {
    // fromSessionTitle comes off the session record and is never
    // client-settable; fromLabel is asserted by whoever sent the prompt.
    expect(
      classifyPromptOrigin({
        fromSession: "hydra_session_PEER",
        fromSessionTitle: "fix flaky test",
        fromLabel: "something-else",
      }),
    ).toEqual({ origin: "peer", label: "fix flaky test" });
  });

  it("falls back to the session id for an untitled peer", () => {
    // Opaque, but it beats an unattributed peer turn.
    expect(
      classifyPromptOrigin({ fromSession: "hydra_session_PEER" }),
    ).toEqual({ origin: "peer", label: "hydra_session_PEER" });
  });

  it("reads a label-only send as a client naming itself", () => {
    // No resolved session, so not a peer. PROTOCOL.md: label-only sends are
    // not depth-bounded and carry no session.
    expect(
      classifyPromptOrigin({
        clientId: "cli_abc",
        name: "hydra-acp-cat",
        fromLabel: "jenkins:12847",
      }),
    ).toEqual({ origin: "client", label: "jenkins:12847" });
  });

  it("falls back to the delivering client's name", () => {
    expect(
      classifyPromptOrigin({ clientId: "cli_abc", name: "hydra-acp-slack" }),
    ).toEqual({ origin: "client", label: "hydra-acp-slack" });
  });

  it("attributes an unlabelled client to no one in particular", () => {
    expect(classifyPromptOrigin({ clientId: "cli_abc" })).toEqual({
      origin: "client",
      label: null,
    });
  });

  it("treats blank strings as absent rather than as a label", () => {
    expect(
      classifyPromptOrigin({ clientId: "cli_abc", name: "   " }),
    ).toEqual({ origin: "client", label: null });
    expect(
      classifyPromptOrigin({ fromSession: "  ", name: "hydra-acp-tui" }),
    ).toEqual({ origin: "client", label: "hydra-acp-tui" });
  });

  it("degrades to an unattributed client rather than guessing peer", () => {
    // A prompt_received we can't attribute still definitely came from
    // outside this pane, which is the part that matters.
    for (const junk of [undefined, null, "nonsense", 42, [], {}]) {
      expect(classifyPromptOrigin(junk)).toEqual({
        origin: "client",
        label: null,
      });
    }
  });

  it("ignores non-string provenance fields", () => {
    expect(
      classifyPromptOrigin({ fromSession: 7, name: { evil: true } }),
    ).toEqual({ origin: "client", label: null });
  });
});

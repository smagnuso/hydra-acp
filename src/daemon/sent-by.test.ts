import { describe, expect, it, vi } from "vitest";
import { normalizeSentBy } from "./sent-by.js";
import type { SessionManager } from "../core/session-manager.js";

// Minimal stand-in for the SessionManager methods normalizeSentBy
// touches. `known` maps canonical id to title; `depths` gives a live
// session's currently-handled hop depth (absent = not live / idle).
function fakeManager(
  known: Record<string, string | undefined>,
  depths: Record<string, number> = {},
): SessionManager {
  return {
    async resolveCanonicalId(input: string) {
      return input in known ? input : undefined;
    },
    async getOne(id: string) {
      if (!(id in known)) {
        return undefined;
      }
      const title = known[id];
      return (title === undefined ? {} : { title }) as never;
    },
    get(id: string) {
      if (!(id in depths)) {
        return undefined;
      }
      return { currentPromptDepth: depths[id] } as never;
    },
  } as unknown as SessionManager;
}

function params(sentBy: unknown): unknown {
  return {
    sessionId: "hydra_session_target",
    prompt: [],
    _meta: { "hydra-acp": { sentBy } },
  };
}

describe("normalizeSentBy", () => {
  it("returns undefined when the prompt carries no provenance", async () => {
    const mgr = fakeManager({});
    expect(await normalizeSentBy({ prompt: [] }, mgr)).toBeUndefined();
    expect(await normalizeSentBy(params(undefined), mgr)).toBeUndefined();
    expect(await normalizeSentBy(params({}), mgr)).toBeUndefined();
  });

  it("resolves a known session id and enriches it with the title", async () => {
    const mgr = fakeManager({ hydra_session_src: "media pipeline refactor" });
    const out = await normalizeSentBy(
      params({ sessionId: "hydra_session_src" }),
      mgr,
    );
    expect(out).toEqual({
      fromSession: "hydra_session_src",
      fromSessionTitle: "media pipeline refactor",
      depth: 1,
    });
  });

  it("keeps a known session with no title", async () => {
    const mgr = fakeManager({ hydra_session_src: undefined });
    const out = await normalizeSentBy(
      params({ sessionId: "hydra_session_src" }),
      mgr,
    );
    expect(out).toEqual({ fromSession: "hydra_session_src", depth: 1 });
  });

  // A stale HYDRA_ACP_SESSION must fail closed: no attribution beats an
  // attribution pointing at a session that was never involved.
  it("drops an unknown session id and reports it", async () => {
    const mgr = fakeManager({});
    const onDropped = vi.fn();
    const out = await normalizeSentBy(
      params({ sessionId: "hydra_session_ghost" }),
      mgr,
      onDropped,
    );
    expect(out).toBeUndefined();
    expect(onDropped).toHaveBeenCalledWith("hydra_session_ghost");
  });

  it("keeps a label even when the session id alongside it is unknown", async () => {
    const mgr = fakeManager({});
    const out = await normalizeSentBy(
      params({ sessionId: "hydra_session_ghost", label: "jenkins:12847" }),
      mgr,
    );
    expect(out).toEqual({ fromLabel: "jenkins:12847" });
  });

  it("passes a bare label through without touching the manager", async () => {
    const mgr = fakeManager({});
    const out = await normalizeSentBy(params({ label: "ci" }), mgr);
    expect(out).toEqual({ fromLabel: "ci" });
  });

  it("truncates an overlong label", async () => {
    const mgr = fakeManager({});
    const out = await normalizeSentBy(
      params({ label: "x".repeat(500) }),
      mgr,
    );
    expect(out?.fromLabel).toHaveLength(200);
  });

  describe("depth", () => {
    // A user-typed turn is depth 0, so the first agent-to-agent hop is 1
    // and each message sent while handling one adds another.
    it("starts at 1 when the sender is handling a user turn", async () => {
      const mgr = fakeManager({ s: "src" }, { s: 0 });
      const out = await normalizeSentBy(params({ sessionId: "s" }), mgr);
      expect(out?.depth).toBe(1);
    });

    it("increments from the depth the sender is currently handling", async () => {
      const mgr = fakeManager({ s: "src" }, { s: 2 });
      const out = await normalizeSentBy(params({ sessionId: "s" }), mgr);
      expect(out?.depth).toBe(3);
    });

    it("starts a fresh chain when the sender has no live turn", async () => {
      // A CI script or a hook asserting a real session id it isn't
      // running inside: nothing to inherit, so this is hop 1.
      const mgr = fakeManager({ s: "src" }, {});
      const out = await normalizeSentBy(params({ sessionId: "s" }), mgr);
      expect(out?.depth).toBe(1);
    });

    it("never takes depth from the client", async () => {
      const mgr = fakeManager({ s: "src" }, { s: 2 });
      const out = await normalizeSentBy(
        params({ sessionId: "s", depth: 0 }),
        mgr,
      );
      expect(out?.depth).toBe(3);
    });

    it("has no depth for a label-only sender", async () => {
      const mgr = fakeManager({});
      const out = await normalizeSentBy(params({ label: "ci" }), mgr);
      expect(out?.depth).toBeUndefined();
    });
  });

  describe("awaiting", () => {
    it("passes the blocking flag through", async () => {
      const mgr = fakeManager({ s: "src" }, { s: 0 });
      const out = await normalizeSentBy(
        params({ sessionId: "s", awaiting: true }),
        mgr,
      );
      expect(out?.awaiting).toBe(true);
    });

    it("is absent for a fire-and-forget send", async () => {
      const mgr = fakeManager({ s: "src" }, { s: 0 });
      const out = await normalizeSentBy(params({ sessionId: "s" }), mgr);
      expect(out?.awaiting).toBeUndefined();
    });
  });

  it("ignores non-string and empty fields", async () => {
    const mgr = fakeManager({});
    expect(
      await normalizeSentBy(params({ sessionId: 42, label: "" }), mgr),
    ).toBeUndefined();
    expect(await normalizeSentBy(params("nope"), mgr)).toBeUndefined();
    expect(await normalizeSentBy(params([1, 2]), mgr)).toBeUndefined();
  });
});

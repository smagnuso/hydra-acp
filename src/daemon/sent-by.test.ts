import { describe, expect, it, vi } from "vitest";
import { normalizeSentBy } from "./sent-by.js";
import type { SessionManager } from "../core/session-manager.js";

// Minimal stand-in for the two SessionManager methods normalizeSentBy
// touches. `known` maps canonical id to title.
function fakeManager(known: Record<string, string | undefined>): SessionManager {
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
    });
  });

  it("keeps a known session with no title", async () => {
    const mgr = fakeManager({ hydra_session_src: undefined });
    const out = await normalizeSentBy(
      params({ sessionId: "hydra_session_src" }),
      mgr,
    );
    expect(out).toEqual({ fromSession: "hydra_session_src" });
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

  it("ignores non-string and empty fields", async () => {
    const mgr = fakeManager({});
    expect(
      await normalizeSentBy(params({ sessionId: 42, label: "" }), mgr),
    ).toBeUndefined();
    expect(await normalizeSentBy(params("nope"), mgr)).toBeUndefined();
    expect(await normalizeSentBy(params([1, 2]), mgr)).toBeUndefined();
  });
});

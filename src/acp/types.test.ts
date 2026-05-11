import { describe, it, expect } from "vitest";
import {
  HYDRA_META_KEY,
  extractHydraMeta,
  mergeMeta,
  SessionAttachParams,
} from "./types.js";

describe("extractHydraMeta", () => {
  it("returns empty when meta is missing", () => {
    expect(extractHydraMeta(undefined)).toEqual({});
  });

  it("returns empty when the hydra key is absent", () => {
    expect(extractHydraMeta({ "some.other": { foo: 1 } })).toEqual({});
  });

  it("extracts known scalar fields", () => {
    expect(
      extractHydraMeta({
        [HYDRA_META_KEY]: {
          upstreamSessionId: "u_x",
          agentId: "claude-code",
          cwd: "/work",
          name: "MyBuffer",
        },
      }),
    ).toEqual({
      upstreamSessionId: "u_x",
      agentId: "claude-code",
      cwd: "/work",
      name: "MyBuffer",
    });
  });

  it("validates and extracts nested resume hints", () => {
    const out = extractHydraMeta({
      [HYDRA_META_KEY]: {
        resume: {
          upstreamSessionId: "u",
          agentId: "a",
          cwd: "/w",
        },
      },
    });
    expect(out.resume).toEqual({
      upstreamSessionId: "u",
      agentId: "a",
      cwd: "/w",
    });
  });

  it("ignores malformed resume hints rather than throwing", () => {
    const out = extractHydraMeta({
      [HYDRA_META_KEY]: { resume: { upstreamSessionId: 42 } },
    });
    expect(out.resume).toBeUndefined();
  });
});

describe("mergeMeta", () => {
  it("preserves passthrough keys and adds hydra namespace", () => {
    const merged = mergeMeta({ "some.other": { foo: 1 } }, { agentId: "x" });
    expect(merged).toEqual({
      "some.other": { foo: 1 },
      [HYDRA_META_KEY]: { agentId: "x" },
    });
  });

  it("overwrites a colliding hydra key in passthrough", () => {
    const merged = mergeMeta(
      { [HYDRA_META_KEY]: { stale: true } },
      { upstreamSessionId: "u" },
    );
    expect(merged[HYDRA_META_KEY]).toEqual({ upstreamSessionId: "u" });
  });

  it("works with no passthrough", () => {
    expect(mergeMeta(undefined, { agentId: "x" })).toEqual({
      [HYDRA_META_KEY]: { agentId: "x" },
    });
  });
});

describe("SessionAttachParams schema", () => {
  it("accepts attach with hydra-namespaced resume hints inside _meta", () => {
    const parsed = SessionAttachParams.parse({
      sessionId: "sess",
      _meta: {
        [HYDRA_META_KEY]: {
          resume: {
            upstreamSessionId: "u",
            agentId: "a",
            cwd: "/w",
          },
        },
      },
    });
    expect(parsed._meta).toBeDefined();
    expect(extractHydraMeta(parsed._meta).resume).toEqual({
      upstreamSessionId: "u",
      agentId: "a",
      cwd: "/w",
    });
  });

  it("accepts attach with only sessionId (defaults applied)", () => {
    const parsed = SessionAttachParams.parse({ sessionId: "sess" });
    expect(parsed.historyPolicy).toBe("full");
    expect(parsed._meta).toBeUndefined();
  });
});

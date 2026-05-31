import { describe, it, expect } from "vitest";
import {
  HYDRA_META_KEY,
  extractHydraMeta,
  mergeMeta,
  SessionAttachParams,
  sessionListEntryToWire,
  buildHydraSessionMeta,
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
          title: "MyBuffer",
        },
      }),
    ).toEqual({
      upstreamSessionId: "u_x",
      agentId: "claude-code",
      cwd: "/work",
      title: "MyBuffer",
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

  it("extracts a caller-requested model field", () => {
    const out = extractHydraMeta({
      [HYDRA_META_KEY]: { model: "openai/gpt-5" },
    });
    expect(out.model).toBe("openai/gpt-5");
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

describe("sessionListEntryToWire", () => {
  it("puts spec fields at the top level and everything else under hydra-acp", () => {
    const wire = sessionListEntryToWire({
      sessionId: "hydra_session_abc",
      cwd: "/work",
      title: "fix flaky test",
      updatedAt: "2026-05-29T18:01:23.000Z",
      attachedClients: 2,
      status: "live",
      busy: false,
      awaitingInput: false,
    });
    expect(wire.sessionId).toBe("hydra_session_abc");
    expect(wire.cwd).toBe("/work");
    expect(wire.title).toBe("fix flaky test");
    expect(wire.updatedAt).toBe("2026-05-29T18:01:23.000Z");
    expect(wire._meta?.[HYDRA_META_KEY]).toEqual({
      attachedClients: 2,
      status: "live",
      busy: false,
      awaitingInput: false,
      cwd: "/work",
      // Title is mirrored into _meta so attach/new and list stay identical.
      title: "fix flaky test",
    });
  });

  it("packs all optional hydra fields into hydra-acp when present", () => {
    const wire = sessionListEntryToWire({
      sessionId: "s",
      cwd: "/w",
      updatedAt: "t",
      attachedClients: 0,
      status: "cold",
      busy: false,
      awaitingInput: false,
      agentId: "claude-acp",
      upstreamSessionId: "u_1",
      currentModel: "claude-opus-4-7",
      currentUsage: { used: 12345, costAmount: 0.18, costCurrency: "USD" },
      importedFromMachine: "host-a",
      importedFromUpstreamSessionId: "u_orig",
      parentSessionId: "p_1",
      forkedFromSessionId: "f_1",
      forkedFromMessageId: "m_1",
      originatingClient: { name: "cli", version: "1.0" },
      interactive: true,
    });
    expect(wire._meta?.[HYDRA_META_KEY]).toEqual({
      attachedClients: 0,
      status: "cold",
      busy: false,
      awaitingInput: false,
      cwd: "/w",
      agentId: "claude-acp",
      upstreamSessionId: "u_1",
      currentModel: "claude-opus-4-7",
      currentUsage: { used: 12345, costAmount: 0.18, costCurrency: "USD" },
      importedFromMachine: "host-a",
      importedFromUpstreamSessionId: "u_orig",
      parentSessionId: "p_1",
      forkedFromSessionId: "f_1",
      forkedFromMessageId: "m_1",
      originatingClient: { name: "cli", version: "1.0" },
      interactive: true,
    });
  });

  it("omits absent optionals and leaves title undefined", () => {
    const wire = sessionListEntryToWire({
      sessionId: "s",
      cwd: "/w",
      updatedAt: "t",
      attachedClients: 0,
      status: "cold",
      busy: false,
      awaitingInput: false,
    });
    expect(wire.title).toBeUndefined();
    const hydra = wire._meta?.[HYDRA_META_KEY] as Record<string, unknown>;
    expect("forkedFromSessionId" in hydra).toBe(false);
    expect("parentSessionId" in hydra).toBe(false);
    expect("interactive" in hydra).toBe(false);
    expect("originatingClient" in hydra).toBe(false);
  });
});

describe("buildHydraSessionMeta", () => {
  const baseEntry = {
    sessionId: "s",
    cwd: "/w",
    title: "my session",
    updatedAt: "t",
    attachedClients: 1,
    status: "live" as const,
    busy: true,
    awaitingInput: false,
    agentId: "claude-acp",
  };

  it("emits the title under the spec-aligned title key", () => {
    const meta = buildHydraSessionMeta(baseEntry);
    expect(meta.title).toBe("my session");
    expect("name" in meta).toBe(false);
    expect(meta.cwd).toBe("/w");
  });

  it("layers live-only extras when provided", () => {
    const meta = buildHydraSessionMeta(baseEntry, {
      currentMode: "ask",
      agentArgs: ["--foo"],
      availableCommands: [{ name: "c" }],
      availableModes: [{ id: "ask" }],
      availableModels: [{ modelId: "m" }],
      turnStartedAt: 123,
      agentCapabilities: { promptCapabilities: {} },
      queue: [{ messageId: "q1" }],
    });
    expect(meta.currentMode).toBe("ask");
    expect(meta.agentArgs).toEqual(["--foo"]);
    expect(meta.availableCommands).toEqual([{ name: "c" }]);
    expect(meta.turnStartedAt).toBe(123);
    expect(meta.queue).toEqual([{ messageId: "q1" }]);
    expect(meta.agentCapabilities).toEqual({ promptCapabilities: {} });
  });

  it("drops empty extras arrays", () => {
    const meta = buildHydraSessionMeta(baseEntry, {
      agentArgs: [],
      availableCommands: [],
      availableModes: [],
      availableModels: [],
      queue: [],
    });
    expect("agentArgs" in meta).toBe(false);
    expect("availableCommands" in meta).toBe(false);
    expect("queue" in meta).toBe(false);
  });

  it("the list wire and a live response share the same triage block", () => {
    // session/list packs via sessionListEntryToWire; attach/new pack via
    // buildHydraSessionMeta with extras. The triage fields must be byte
    // identical so a client sees one consistent shape across surfaces.
    const wire = sessionListEntryToWire(baseEntry);
    const live = buildHydraSessionMeta(baseEntry, { currentMode: "ask" });
    for (const k of [
      "status",
      "busy",
      "awaitingInput",
      "attachedClients",
      "agentId",
      "title",
      "cwd",
    ]) {
      expect((live as Record<string, unknown>)[k]).toEqual(
        (wire._meta?.[HYDRA_META_KEY] as Record<string, unknown>)[k],
      );
    }
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

import { describe, it, expect } from "vitest";
import {
  HYDRA_META_KEY,
  extractHydraMeta,
  mergeMeta,
  withRecordedAt,
  extractRecordedAt,
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
          clientId: "cli_x",
          title: "MyBuffer",
        },
      }),
    ).toEqual({
      upstreamSessionId: "u_x",
      agentId: "claude-code",
      cwd: "/work",
      clientId: "cli_x",
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

  it("extracts a well-formed env map (keys and string values only)", () => {
    const out = extractHydraMeta({
      [HYDRA_META_KEY]: { env: { FOO: "bar", BAZ: "qux" } },
    });
    expect(out.env).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("preserves an explicit empty env map (means 'clear')", () => {
    const out = extractHydraMeta({ [HYDRA_META_KEY]: { env: {} } });
    expect(out.env).toEqual({});
  });

  it("drops env when a value is non-string", () => {
    const out = extractHydraMeta({
      [HYDRA_META_KEY]: { env: { FOO: 42 } as unknown as Record<string, string> },
    });
    expect(out.env).toBeUndefined();
  });

  it("drops env when it isn't a plain object", () => {
    const out = extractHydraMeta({
      [HYDRA_META_KEY]: {
        env: ["FOO=bar"] as unknown as Record<string, string>,
      },
    });
    expect(out.env).toBeUndefined();
  });
});

describe("redactHydraMetaForLog", () => {
  it("replaces env values with key-only scaffold", async () => {
    const { redactHydraMetaForLog } = await import("./types-hydra-meta.js");
    const redacted = redactHydraMetaForLog({
      [HYDRA_META_KEY]: { env: { SECRET: "shh", OTHER: "v" } },
    });
    const stringified = JSON.stringify(redacted);
    expect(stringified).not.toContain("shh");
    expect(stringified).not.toContain('"v"');
    expect(redacted?.[HYDRA_META_KEY]).toMatchObject({
      env: { keys: ["SECRET", "OTHER"], count: 2 },
    });
  });

  it("is a no-op when no env field is present", async () => {
    const { redactHydraMetaForLog } = await import("./types-hydra-meta.js");
    const input = { [HYDRA_META_KEY]: { agentId: "x" } };
    expect(redactHydraMetaForLog(input)).toEqual(input);
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
      status: "warm",
      busy: false,
      awaitingInput: false,
    });
    expect(wire.sessionId).toBe("hydra_session_abc");
    expect(wire.cwd).toBe("/work");
    expect(wire.title).toBe("fix flaky test");
    expect(wire.updatedAt).toBe("2026-05-29T18:01:23.000Z");
    expect(wire._meta?.[HYDRA_META_KEY]).toEqual({
      attachedClients: 2,
      status: "warm",
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
    status: "warm" as const,
    busy: true,
    awaitingInput: false,
    agentId: "claude-acp",
  };

  // The builder and extractHydraMeta are two hand-maintained lists of the
  // same field set, and nothing forced them to agree: extract parses
  // key-by-key on purpose (so a malformed block fails open rather than
  // reaching a provider as junk), while HydraMeta declares every field
  // optional. Declare a field, emit it, forget to parse it, and every
  // reader gets `undefined` with no type error and no test failure. That
  // is how an isolated session came to attach with its binding stripped
  // on the client side.
  //
  // So: emit everything, parse it back, and require the round trip.
  it("parses back every field it emits", () => {
    const meta = buildHydraSessionMeta(
      {
        ...baseEntry,
        upstreamSessionId: "up_1",
        workspace: {
          path: "/ws/feature-x",
          sourceCwd: "/w",
          label: "feature-x",
          provider: "git",
          snapshot: "abc123",
          vcs: { kind: "git", branch: "hydra/feature-x" },
        },
        workspaceError: "provider unavailable",
        currentModel: "opus",
        armedTasks: 2,
        armedSince: 1_700_000_000_000,
      },
      {
        clientId: "cli_abc",
        currentMode: "ask",
        agentArgs: ["--foo"],
        availableCommands: [{ name: "c" }],
        availableModes: [{ id: "ask" }],
        availableModels: [{ modelId: "m" }],
        turnStartedAt: 123,
      },
    );
    const parsed = extractHydraMeta({ "hydra-acp": meta }) as Record<string, unknown>;

    // Triage fields with their own readers on the client side: they are
    // deliberately outside HydraMeta, so extract not knowing them is
    // correct rather than an omission.
    const notInHydraMeta = new Set([
      "attachedClients",
      "status",
      "busy",
      "awaitingInput",
      "updatedAt",
      "interactive",
      "priority",
      "agentPid",
      "compactionState",
      "forkSynthesisState",
      "forkedFromSessionId",
      "forkedFromMessageId",
      "parentSessionId",
      "originatingClient",
      "currentUsage",
      "synopsis",
      "summarizedThroughEntry",
      "agentCommands",
      "agentModes",
      "agentModels",
      "availableCommands",
      "availableModes",
      "availableModels",
      "queue",
      "agentCapabilities",
      "resurrected",
      "sessionId",
      "lineageId",
    ]);
    const dropped = Object.keys(meta).filter(
      (k) => !notInHydraMeta.has(k) && parsed[k] === undefined,
    );
    expect(dropped).toEqual([]);
  });

  // Armed state is push-only on the client side, so the attach response is
  // the only place a client can RESYNC it. A session that closes and returns
  // (force-cancel, crash, resurrect) comes back with an empty in-memory
  // armed map and never broadcasts that, so without these two fields on the
  // attach meta a client keeps a "running" clock from the previous
  // incarnation forever.
  it("carries armed background tasks, including the zero that clears them", () => {
    const armed = buildHydraSessionMeta({
      ...baseEntry,
      armedTasks: 3,
      armedSince: 1_700_000_000_000,
    });
    expect(armed.armedTasks).toBe(3);
    expect(armed.armedSince).toBe(1_700_000_000_000);

    // The load-bearing case: 0 is the daemon saying "nothing armed", which
    // is what clears a stale badge. A truthiness guard in either the builder
    // or the parser would drop it and the badge would stick.
    const idle = buildHydraSessionMeta({ ...baseEntry, armedTasks: 0 });
    expect(idle.armedTasks).toBe(0);
    expect(idle.armedSince).toBeUndefined();
    expect(extractHydraMeta({ "hydra-acp": idle }).armedTasks).toBe(0);

    // Absent is distinct from 0: a daemon too old to report armed state
    // must not be read as one reporting none, or it would clear a live
    // badge on every reattach.
    const silent = buildHydraSessionMeta(baseEntry);
    expect("armedTasks" in silent).toBe(false);
    expect(extractHydraMeta({ "hydra-acp": silent }).armedTasks).toBeUndefined();
  });

  // The list, not just the count: a client painting running jobs by name
  // needs to seed on attach, or a mid-flight attach knows how many are
  // running but not what they are until the next membership change.
  it("carries the armed task list, and keeps empty distinct from absent", () => {
    const listed = buildHydraSessionMeta(baseEntry, {
      armedTaskList: [
        { taskId: "bg_1", label: "device run", taskType: "local_bash", since: 1_700_000_000_000 },
      ],
    });
    expect(extractHydraMeta({ "hydra-acp": listed }).armedTaskList).toEqual([
      { taskId: "bg_1", label: "device run", taskType: "local_bash", since: 1_700_000_000_000 },
    ]);

    // Same load-bearing case as the zero above: an empty list is the daemon
    // saying "nothing is running", which is what clears a stale panel. A
    // length guard in builder or parser would drop it and the panel sticks.
    const empty = buildHydraSessionMeta(baseEntry, { armedTaskList: [] });
    expect(empty.armedTaskList).toEqual([]);
    expect(extractHydraMeta({ "hydra-acp": empty }).armedTaskList).toEqual([]);

    const old = buildHydraSessionMeta(baseEntry);
    expect("armedTaskList" in old).toBe(false);
    expect(extractHydraMeta({ "hydra-acp": old }).armedTaskList).toBeUndefined();
  });

  // A malformed entry must not void the whole list: a partial list still
  // beats falling back to a bare count.
  it("drops unusable armed entries rather than the whole list", () => {
    const meta = buildHydraSessionMeta(baseEntry, {
      armedTaskList: [
        { label: "good", since: 1_700_000_000_000 },
        { label: "no since" },
        { since: 1_700_000_000_001 },
        "not an object",
      ],
    });
    expect(extractHydraMeta({ "hydra-acp": meta }).armedTaskList).toEqual([
      { label: "good", since: 1_700_000_000_000 },
    ]);
  });

  it("carries the workspace binding through to the client, not just its cwd", () => {
    // Regression, and the specific case above: cwd for an isolated
    // session is an anonymous hash directory, so a client that gets cwd
    // without sourceCwd has no project to name and cannot tell that the
    // session is isolated at all.
    const meta = buildHydraSessionMeta({
      ...baseEntry,
      cwd: "/ws/feature-x",
      workspace: {
        path: "/ws/feature-x",
        sourceCwd: "/w",
        label: "feature-x",
        provider: "git",
        vcs: { kind: "git", branch: "hydra/feature-x" },
      },
    });
    const parsed = extractHydraMeta({ "hydra-acp": meta });
    expect(parsed.workspaceInfo).toEqual({
      path: "/ws/feature-x",
      sourceCwd: "/w",
      label: "feature-x",
      provider: "git",
      vcs: { kind: "git", branch: "hydra/feature-x" },
    });
  });

  it("drops a workspace block that is missing the fields readers rely on", () => {
    // Partial is worse than absent: sourceCwd is what names the project.
    const parsed = extractHydraMeta({
      "hydra-acp": { workspaceInfo: { path: "/ws/x", label: "x" } },
    });
    expect(parsed.workspaceInfo).toBeUndefined();
  });

  it("emits the title under the spec-aligned title key", () => {
    const meta = buildHydraSessionMeta(baseEntry);
    expect(meta.title).toBe("my session");
    expect("name" in meta).toBe(false);
    expect(meta.cwd).toBe("/w");
  });

  it("layers live-only extras when provided", () => {
    const meta = buildHydraSessionMeta(baseEntry, {
      clientId: "cli_abc",
      currentMode: "ask",
      agentArgs: ["--foo"],
      availableCommands: [{ name: "c" }],
      availableModes: [{ id: "ask" }],
      availableModels: [{ modelId: "m" }],
      turnStartedAt: 123,
      agentCapabilities: { promptCapabilities: {} },
      queue: [{ messageId: "q1" }],
    });
    expect(meta.clientId).toBe("cli_abc");
    expect(meta.currentMode).toBe("ask");
    expect(meta.agentArgs).toEqual(["--foo"]);
    expect(meta.availableCommands).toEqual([{ name: "c" }]);
    expect(meta.turnStartedAt).toBe(123);
    expect(meta.queue).toEqual([{ messageId: "q1" }]);
    expect(meta.agentCapabilities).toEqual({ promptCapabilities: {} });
  });

  it("omits clientId when not provided (session/list path)", () => {
    const meta = buildHydraSessionMeta(baseEntry);
    expect("clientId" in meta).toBe(false);
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

describe("withRecordedAt", () => {
  const meta = (params: unknown) =>
    ((params as Record<string, unknown>)._meta as Record<string, unknown>)[
      HYDRA_META_KEY
    ] as Record<string, unknown>;

  it("stamps recordedAt under the hydra meta namespace", () => {
    const out = withRecordedAt({ sessionId: "s", update: { a: 1 } }, 1234);
    expect(meta(out).recordedAt).toBe(1234);
    expect((out as Record<string, unknown>).update).toEqual({ a: 1 });
  });

  it("preserves sibling hydra meta fields", () => {
    const out = withRecordedAt(
      { sessionId: "s", _meta: { [HYDRA_META_KEY]: { amending: true } } },
      99,
    );
    expect(meta(out)).toEqual({ amending: true, recordedAt: 99 });
  });

  it("preserves foreign meta namespaces", () => {
    const out = withRecordedAt({ _meta: { "other-vendor": { x: 1 } } }, 5);
    const m = (out as Record<string, unknown>)._meta as Record<string, unknown>;
    expect(m["other-vendor"]).toEqual({ x: 1 });
    expect(meta(out).recordedAt).toBe(5);
  });

  it("does not overwrite an existing recordedAt", () => {
    const out = withRecordedAt(
      { _meta: { [HYDRA_META_KEY]: { recordedAt: 1 } } },
      2,
    );
    expect(meta(out).recordedAt).toBe(1);
  });

  it("returns params untouched when recordedAt is absent or non-finite", () => {
    const params = { sessionId: "s" };
    expect(withRecordedAt(params, undefined)).toBe(params);
    expect(withRecordedAt(params, NaN)).toBe(params);
  });

  it("does not mutate the input", () => {
    const params = { sessionId: "s" };
    withRecordedAt(params, 7);
    expect(params).toEqual({ sessionId: "s" });
  });

  it("passes through non-object params", () => {
    expect(withRecordedAt(undefined, 1)).toBeUndefined();
    expect(withRecordedAt([1], 1)).toEqual([1]);
  });
});

describe("extractRecordedAt", () => {
  it("round-trips a value written by withRecordedAt", () => {
    const stamped = withRecordedAt({ sessionId: "s", update: {} }, 1782587063587);
    expect(extractRecordedAt(stamped)).toBe(1782587063587);
  });

  it("reads through sibling hydra meta fields", () => {
    const stamped = withRecordedAt(
      { _meta: { [HYDRA_META_KEY]: { amending: true } } },
      42,
    );
    expect(extractRecordedAt(stamped)).toBe(42);
  });

  it("returns undefined for an unstamped payload", () => {
    expect(extractRecordedAt({ sessionId: "s", update: {} })).toBeUndefined();
    expect(extractRecordedAt({ _meta: {} })).toBeUndefined();
    expect(extractRecordedAt({ _meta: { [HYDRA_META_KEY]: {} } })).toBeUndefined();
  });

  it("returns undefined for a foreign-only meta namespace", () => {
    expect(
      extractRecordedAt({ _meta: { "other-vendor": { recordedAt: 5 } } }),
    ).toBeUndefined();
  });

  it("rejects non-numeric and non-finite stamps", () => {
    expect(
      extractRecordedAt({ _meta: { [HYDRA_META_KEY]: { recordedAt: "123" } } }),
    ).toBeUndefined();
    expect(
      extractRecordedAt({ _meta: { [HYDRA_META_KEY]: { recordedAt: NaN } } }),
    ).toBeUndefined();
  });

  it("tolerates junk input", () => {
    expect(extractRecordedAt(undefined)).toBeUndefined();
    expect(extractRecordedAt(null)).toBeUndefined();
    expect(extractRecordedAt("nope")).toBeUndefined();
    expect(extractRecordedAt({ _meta: "nope" })).toBeUndefined();
    expect(extractRecordedAt({ _meta: { [HYDRA_META_KEY]: 7 } })).toBeUndefined();
  });
});

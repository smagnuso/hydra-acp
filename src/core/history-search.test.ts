import { describe, it, expect } from "vitest";
import {
  buildSnippet,
  extractSearchableFragments,
  parseQuery,
  scanSessionEntries,
  searchHistories,
  type ParsedQuery,
  type SessionSearchResponse,
} from "./history-search.js";

// Convenience: wrap a single term+scope into a ParsedQuery for tests
// that only care about one term at a time.
const q = (term: string, scope: ParsedQuery["terms"][number]["scope"] = "all"): ParsedQuery => ({
  operator: "OR",
  terms: [{ scope, term }],
});
import type { HistoryEntry } from "./history-store.js";
import type { SessionManager } from "./session-manager.js";

// Lightweight stand-in for SessionManager. The search code only touches
// .list() and .loadHistory(); keeping the fake small means a test
// failure points at the matcher, not at session bootstrap.
interface FakeSession {
  sessionId: string;
  cwd: string;
  status: "live" | "cold";
  title?: string;
  updatedAt: string;
  history: HistoryEntry[];
}

function fakeManager(sessions: FakeSession[]): SessionManager {
  const map = new Map(sessions.map((s) => [s.sessionId, s.history]));
  return {
    list: async () =>
      sessions.map((s) => ({
        sessionId: s.sessionId,
        cwd: s.cwd,
        status: s.status,
        title: s.title,
        updatedAt: s.updatedAt,
        attachedClients: 0,
        busy: false,
      })),
    loadHistory: async (id: string) => map.get(id) ?? [],
  } as unknown as SessionManager;
}

function userEntry(text: string, recordedAt = 1): HistoryEntry {
  return {
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "prompt_received",
        prompt: [{ type: "text", text }],
      },
    },
    recordedAt,
  };
}

function agentEntry(text: string, recordedAt = 1): HistoryEntry {
  return {
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    },
    recordedAt,
  };
}

function toolCallEntry(
  toolName: string,
  rawInput: Record<string, unknown>,
  opts: { title?: string; locations?: unknown; recordedAt?: number } = {},
): HistoryEntry {
  return {
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc1",
        name: toolName,
        title: opts.title ?? toolName,
        rawInput,
        locations: opts.locations,
      },
    },
    recordedAt: opts.recordedAt ?? 1,
  };
}

describe("parseQuery", () => {
  it("single term, no prefix → OR with scope all", () => {
    expect(parseQuery("banana")).toEqual({
      operator: "OR",
      terms: [{ scope: "all", term: "banana" }],
    });
  });

  it("prompt: prefix → user scope", () => {
    expect(parseQuery("prompt:banana")).toEqual({
      operator: "OR",
      terms: [{ scope: "user", term: "banana" }],
    });
    expect(parseQuery("PROMPT:banana")).toEqual({
      operator: "OR",
      terms: [{ scope: "user", term: "banana" }],
    });
  });

  it("response: prefix → agent scope", () => {
    expect(parseQuery("response:banana")).toEqual({
      operator: "OR",
      terms: [{ scope: "agent", term: "banana" }],
    });
  });

  it("tool: prefix → tool scope", () => {
    expect(parseQuery("tool:foo.ts")).toEqual({
      operator: "OR",
      terms: [{ scope: "tool", term: "foo.ts" }],
    });
  });

  it("bare prefix with no term → empty terms list", () => {
    expect(parseQuery("tool:")).toEqual({ operator: "OR", terms: [] });
  });

  it("unknown prefix → treated as bare all-scope term", () => {
    expect(parseQuery("file:foo.ts")).toEqual({
      operator: "OR",
      terms: [{ scope: "all", term: "file:foo.ts" }],
    });
  });

  it("AND splits into multiple terms (uppercase)", () => {
    expect(parseQuery("foo AND bar")).toEqual({
      operator: "AND",
      terms: [{ scope: "all", term: "foo" }, { scope: "all", term: "bar" }],
    });
  });

  it("and splits into multiple terms (lowercase)", () => {
    expect(parseQuery("foo and bar")).toEqual({
      operator: "AND",
      terms: [{ scope: "all", term: "foo" }, { scope: "all", term: "bar" }],
    });
  });

  it("OR splits into multiple terms", () => {
    expect(parseQuery("foo OR bar")).toEqual({
      operator: "OR",
      terms: [{ scope: "all", term: "foo" }, { scope: "all", term: "bar" }],
    });
  });

  it("AND with per-term scopes", () => {
    expect(parseQuery("prompt:auth AND tool:Edit")).toEqual({
      operator: "AND",
      terms: [{ scope: "user", term: "auth" }, { scope: "tool", term: "Edit" }],
    });
  });

  it("AND wins over OR when both appear", () => {
    expect(parseQuery("foo AND bar OR baz").operator).toBe("AND");
  });

  it("blank query → empty terms", () => {
    expect(parseQuery("")).toEqual({ operator: "OR", terms: [] });
    expect(parseQuery("   ")).toEqual({ operator: "OR", terms: [] });
  });

  it("quoted string is a single literal term, and inside is not split", () => {
    expect(parseQuery('"drag and drop"')).toEqual({
      operator: "OR",
      terms: [{ scope: "all", term: "drag and drop" }],
    });
  });

  it("quoted string protects AND/OR keywords inside it", () => {
    expect(parseQuery('"foo AND bar"')).toEqual({
      operator: "OR",
      terms: [{ scope: "all", term: "foo AND bar" }],
    });
  });

  it("prefix with quoted term: prompt:\"foo bar\"", () => {
    expect(parseQuery('prompt:"drag and drop"')).toEqual({
      operator: "OR",
      terms: [{ scope: "user", term: "drag and drop" }],
    });
  });

  it("quoted term combined with AND operator", () => {
    expect(parseQuery('"drag and drop" AND auth')).toEqual({
      operator: "AND",
      terms: [
        { scope: "all", term: "drag and drop" },
        { scope: "all", term: "auth" },
      ],
    });
  });

  it("mixed quoted and prefixed terms with AND", () => {
    expect(parseQuery('prompt:"sign in" AND tool:Edit')).toEqual({
      operator: "AND",
      terms: [
        { scope: "user", term: "sign in" },
        { scope: "tool", term: "Edit" },
      ],
    });
  });
});

describe("buildSnippet", () => {
  it("centers the match with surrounding context and ellipses", () => {
    const text = "x".repeat(200) + "needle" + "y".repeat(200);
    const idx = text.toLowerCase().indexOf("needle");
    const snippet = buildSnippet(text, idx, "needle".length);
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet).toContain("needle");
  });

  it("omits leading ellipsis when the match is near the start", () => {
    const snippet = buildSnippet("needle in a haystack", 0, "needle".length);
    expect(snippet.startsWith("…")).toBe(false);
    expect(snippet.startsWith("needle")).toBe(true);
  });

  it("collapses internal whitespace so multi-line text fits one row", () => {
    const text = "hello\n\n\nworld   here is\tthe needle here";
    const idx = text.toLowerCase().indexOf("needle");
    const snippet = buildSnippet(text, idx, "needle".length);
    expect(snippet).not.toMatch(/\s{2,}/);
    expect(snippet).not.toContain("\n");
    expect(snippet).toContain("needle");
  });
});

describe("extractSearchableFragments", () => {
  it("returns an agent fragment for an agent_message_chunk", () => {
    const frags = extractSearchableFragments(
      agentEntry("hello world"),
    );
    expect(frags).toEqual([{ kind: "agent", text: "hello world" }]);
  });

  it("returns a user fragment for a prompt_received entry", () => {
    const frags = extractSearchableFragments(userEntry("ship it"));
    expect(frags).toEqual([{ kind: "user", text: "ship it" }]);
  });

  it("emits separate title, name, and rawInput fragments for a tool call", () => {
    const frags = extractSearchableFragments(
      toolCallEntry(
        "Edit",
        { file_path: "/home/me/src/foo.ts" },
        { title: "Edit /home/me/src/foo.ts" },
      ),
    );
    // title and rawInput emit; name dedupes against title-as-name when
    // the title already starts with the name? No — extractor compares
    // title equality with name only, so "Edit /home/..." ≠ "Edit"
    // and we get all three.
    expect(frags.map((f) => f.kind)).toEqual(["tool", "tool", "tool-input"]);
    expect(frags[0]?.text).toBe("Edit /home/me/src/foo.ts");
    expect(frags[0]?.toolName).toBe("Edit");
    expect(frags[1]?.text).toBe("Edit");
    expect(frags[2]?.text).toContain("/home/me/src/foo.ts");
  });

  it("includes locations as a tool-input fragment when present", () => {
    const frags = extractSearchableFragments(
      toolCallEntry(
        "MultiEdit",
        { edits: [] },
        { locations: [{ path: "/x/y.ts", line: 12 }] },
      ),
    );
    const inputFrags = frags.filter((f) => f.kind === "tool-input");
    expect(inputFrags.some((f) => f.text.includes("/x/y.ts"))).toBe(true);
  });

  it("skips entries that aren't session/update", () => {
    const frags = extractSearchableFragments({
      method: "something/else",
      params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } } },
      recordedAt: 1,
    });
    expect(frags).toEqual([]);
  });

  it("skips mode-changed and usage-update entries", () => {
    const frags = extractSearchableFragments({
      method: "session/update",
      params: { update: { sessionUpdate: "current_mode_update", mode: "thinking" } },
      recordedAt: 1,
    });
    expect(frags).toEqual([]);
  });

  it("skips the compat user_message_chunk that shadows prompt_received", () => {
    const frags = extractSearchableFragments({
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "ship it" },
          _meta: { "hydra-acp": { compatFor: "prompt_received" } },
        },
      },
      recordedAt: 1,
    });
    expect(frags).toEqual([]);
  });
});

describe("scanSessionEntries", () => {
  it("matches case-insensitively across mixed entry kinds", () => {
    const result = scanSessionEntries(
      [userEntry("hello Foo"), agentEntry("see FOO over there")],
      q("foo"),
      10,
    );
    expect(result.totalMatches).toBe(2);
    expect(result.snippets.map((s) => s.kind)).toEqual(["user", "agent"]);
  });

  it("counts repeated occurrences within a single fragment as total but emits one snippet", () => {
    const result = scanSessionEntries([agentEntry("foo foo foo")], q("foo"), 10);
    expect(result.totalMatches).toBe(3);
    expect(result.snippets).toHaveLength(1);
  });

  it("caps emitted snippets at maxSnippets while continuing to count totalMatches", () => {
    const entries: HistoryEntry[] = [];
    for (let i = 0; i < 10; i++) {
      entries.push(agentEntry(`needle ${i}`));
    }
    const result = scanSessionEntries(entries, q("needle"), 3);
    expect(result.snippets).toHaveLength(3);
    expect(result.totalMatches).toBe(10);
  });

  it("scope user only matches prompt entries", () => {
    const result = scanSessionEntries(
      [userEntry("needle prompt"), agentEntry("needle response")],
      q("needle", "user"),
      10,
    );
    expect(result.snippets.map((s) => s.kind)).toEqual(["user"]);
    expect(result.totalMatches).toBe(1);
  });

  it("scope agent matches agent text and thoughts, not user", () => {
    const thoughtEntry: HistoryEntry = {
      method: "session/update",
      params: { update: { sessionUpdate: "agent_thought_chunk", text: "needle thought" } },
      recordedAt: 3,
    };
    const result = scanSessionEntries(
      [userEntry("needle prompt"), agentEntry("needle response"), thoughtEntry],
      q("needle", "agent"),
      10,
    );
    expect(result.snippets.map((s) => s.kind)).toEqual(["agent", "thought"]);
    expect(result.totalMatches).toBe(2);
  });

  it("scope tool matches tool entries only, not prose", () => {
    const result = scanSessionEntries(
      [userEntry("needle"), agentEntry("needle"), toolCallEntry("Bash", { command: "echo needle" })],
      q("needle", "tool"),
      10,
    );
    expect(result.snippets.every((s) => s.kind === "tool" || s.kind === "tool-input")).toBe(true);
    expect(result.snippets.length).toBeGreaterThan(0);
  });

  it("matches tool-input fields by file path", () => {
    const result = scanSessionEntries(
      [toolCallEntry("Edit", { file_path: "/home/me/src/foo.ts", content: "x" })],
      q("foo.ts"),
      5,
    );
    expect(result.totalMatches).toBeGreaterThan(0);
    const hit = result.snippets.find((s) => s.kind === "tool-input");
    expect(hit).toBeDefined();
    expect(hit?.toolName).toBe("Edit");
    expect(hit?.text).toContain("foo.ts");
  });

  it("matches a Bash command in rawInput", () => {
    const result = scanSessionEntries(
      [toolCallEntry("Bash", { command: "rg deadbeef src/" })],
      q("deadbeef"),
      5,
    );
    expect(result.snippets.length).toBeGreaterThan(0);
    expect(result.snippets[0]?.kind).toBe("tool-input");
    expect(result.snippets[0]?.toolName).toBe("Bash");
  });

  it("AND: returns snippets from both terms when both match", () => {
    const result = scanSessionEntries(
      [userEntry("alpha"), agentEntry("beta")],
      { operator: "AND", terms: [{ scope: "all", term: "alpha" }, { scope: "all", term: "beta" }] },
      10,
    );
    expect(result.totalMatches).toBe(2);
    expect(result.snippets).toHaveLength(2);
    expect(result.snippets.map((s) => s.kind)).toEqual(["user", "agent"]);
  });

  it("AND: returns empty when any term has no match", () => {
    const result = scanSessionEntries(
      [userEntry("alpha")],
      { operator: "AND", terms: [{ scope: "all", term: "alpha" }, { scope: "all", term: "missing" }] },
      10,
    );
    expect(result.totalMatches).toBe(0);
    expect(result.snippets).toHaveLength(0);
  });

  it("OR: returns snippets for whichever terms match, ignores misses", () => {
    const result = scanSessionEntries(
      [userEntry("alpha")],
      { operator: "OR", terms: [{ scope: "all", term: "alpha" }, { scope: "all", term: "missing" }] },
      10,
    );
    expect(result.totalMatches).toBe(1);
    expect(result.snippets).toHaveLength(1);
  });

  it("AND with per-term scopes: prompt:auth AND tool:Edit", () => {
    const result = scanSessionEntries(
      [userEntry("authenticate with auth token"), toolCallEntry("Edit", { file_path: "/src/auth.ts" })],
      { operator: "AND", terms: [{ scope: "user", term: "auth" }, { scope: "tool", term: "Edit" }] },
      10,
    );
    expect(result.totalMatches).toBeGreaterThan(0);
    expect(result.snippets.some((s) => s.kind === "user")).toBe(true);
    expect(result.snippets.some((s) => s.kind === "tool" || s.kind === "tool-input")).toBe(true);
  });
});

describe("searchHistories", () => {
  it("returns results grouped by session, ordered as the manager listed them", async () => {
    const manager = fakeManager([
      {
        sessionId: "hydra_session_a",
        cwd: "/a",
        status: "live",
        title: "Session A",
        updatedAt: "2026-05-20T00:00:00Z",
        history: [userEntry("alpha banana"), agentEntry("more banana")],
      },
      {
        sessionId: "hydra_session_b",
        cwd: "/b",
        status: "cold",
        updatedAt: "2026-05-19T00:00:00Z",
        history: [agentEntry("just cherries")],
      },
    ]);
    const out = (await searchHistories(manager, "banana")) as SessionSearchResponse;
    expect(out.query).toBe("banana");
    expect(out.truncated).toBe(false);
    expect(out.results).toHaveLength(1);
    expect(out.results[0]?.sessionId).toBe("hydra_session_a");
    expect(out.results[0]?.title).toBe("Session A");
    expect(out.results[0]?.totalMatches).toBe(2);
    expect(out.results[0]?.snippets).toHaveLength(2);
  });

  it("honors sessionIds to scope the scan", async () => {
    const manager = fakeManager([
      {
        sessionId: "hydra_session_a",
        cwd: "/a",
        status: "live",
        updatedAt: "2026-05-20T00:00:00Z",
        history: [agentEntry("banana")],
      },
      {
        sessionId: "hydra_session_b",
        cwd: "/b",
        status: "cold",
        updatedAt: "2026-05-19T00:00:00Z",
        history: [agentEntry("banana")],
      },
    ]);
    const out = await searchHistories(manager, "banana", {
      sessionIds: ["hydra_session_b"],
    });
    expect(out.results.map((r) => r.sessionId)).toEqual(["hydra_session_b"]);
  });

  it("marks truncated when more than maxSessions match", async () => {
    const sessions: FakeSession[] = [];
    for (let i = 0; i < 5; i++) {
      sessions.push({
        sessionId: `hydra_session_${i}`,
        cwd: "/x",
        status: "cold",
        updatedAt: `2026-05-${10 + i}T00:00:00Z`,
        history: [agentEntry("needle")],
      });
    }
    const out = await searchHistories(fakeManager(sessions), "needle", {
      maxSessions: 3,
    });
    expect(out.results).toHaveLength(3);
    expect(out.truncated).toBe(true);
  });

  it("returns empty results for a blank query", async () => {
    const out = await searchHistories(fakeManager([]), "   ");
    expect(out.results).toEqual([]);
    expect(out.truncated).toBe(false);
  });

  it("prefix prompt: only returns sessions with matching user text", async () => {
    const manager = fakeManager([
      {
        sessionId: "hydra_session_a",
        cwd: "/a",
        status: "cold",
        updatedAt: "2026-05-20T00:00:00Z",
        history: [
          userEntry("needle in prompt"),
          agentEntry("needle in response"),
        ],
      },
    ]);
    const out = await searchHistories(manager, "prompt:needle");
    expect(out.query).toBe("prompt:needle");
    expect(out.results).toHaveLength(1);
    expect(out.results[0]?.snippets.every((s) => s.kind === "user")).toBe(true);
  });

  it("prefix tool: skips sessions that only match in prose", async () => {
    const manager = fakeManager([
      {
        sessionId: "hydra_session_prose",
        cwd: "/a",
        status: "cold",
        updatedAt: "2026-05-20T00:00:00Z",
        history: [agentEntry("needle in prose")],
      },
      {
        sessionId: "hydra_session_tool",
        cwd: "/b",
        status: "cold",
        updatedAt: "2026-05-19T00:00:00Z",
        history: [toolCallEntry("Bash", { command: "needle cmd" })],
      },
    ]);
    const out = await searchHistories(manager, "tool:needle");
    expect(out.results.map((r) => r.sessionId)).toEqual(["hydra_session_tool"]);
  });

  it("bare prefix with empty term returns no results", async () => {
    const manager = fakeManager([
      {
        sessionId: "hydra_session_a",
        cwd: "/a",
        status: "cold",
        updatedAt: "2026-05-20T00:00:00Z",
        history: [agentEntry("anything")],
      },
    ]);
    const out = await searchHistories(manager, "tool:");
    expect(out.results).toEqual([]);
  });
});

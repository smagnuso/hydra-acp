import { describe, expect, it } from "vitest";
import type { DiscoveredSession } from "./discovery.js";
import { sessionCandidates, sessionToken, slugify } from "./session-mentions.js";

function sess(over: Partial<DiscoveredSession>): DiscoveredSession {
  return {
    sessionId: "hydra_session_ab12cd34",
    cwd: "/home/u/proj",
    attachedClients: 0,
    updatedAt: "2026-11-01T00:00:00.000Z",
    status: "cold",
    ...over,
  };
}

describe("slugify", () => {
  it("lowercases, hyphenates and trims", () => {
    expect(slugify("Fix the Login Bug!")).toBe("fix-the-login-bug");
    expect(slugify("  --weird__title-- ")).toBe("weird-title");
  });

  it("cuts a long title at a word boundary", () => {
    expect(slugify("Codex @ handling in TUI and browser prompts")).toBe("codex-handling-in-tui");
    expect(slugify("Nolan Lawson's AI cost of JavaScript frameworks")).toBe("nolan-lawson-s-ai-cost");
  });

  it("hard-cuts a single very long word", () => {
    expect(slugify("a" + "b".repeat(40))).toBe("a" + "b".repeat(23));
  });

  it("caps the length without leaving a trailing hyphen", () => {
    const slug = slugify("a very long session title that keeps going on and on");
    expect(slug.length).toBeLessThanOrEqual(24);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("sessionToken", () => {
  it("is the slug plus a short id so equal titles stay distinct", () => {
    expect(sessionToken(sess({ title: "Fix login" }))).toBe("@fix-login-ab12");
    expect(sessionToken(sess({ sessionId: "hydra_session_ff00aa", title: "Fix login" }))).toBe(
      "@fix-login-ff00",
    );
  });

  it("falls back for an untitled session", () => {
    expect(sessionToken(sess({ title: undefined }))).toBe("@session-ab12");
  });
});

describe("sessionCandidates", () => {
  const a = sess({ sessionId: "hydra_session_aaaa1111", title: "Fix login bug", updatedAt: "2026-11-01T00:00:00Z" });
  const b = sess({ sessionId: "hydra_session_bbbb2222", title: "Login redesign", updatedAt: "2026-11-05T00:00:00Z" });
  const c = sess({ sessionId: "hydra_session_cccc3333", title: "Unrelated", updatedAt: "2026-11-07T00:00:00Z" });

  it("matches by title, newest first", () => {
    const got = sessionCandidates("login", [a, b, c]);
    expect(got.map((x) => x.choice)).toEqual(["@login-redesign-bbbb", "@fix-login-bug-aaaa"]);
  });

  it("ranks a title match above a cwd-only match, whatever the recency", () => {
    const inCwd = sess({
      sessionId: "hydra_session_eeee5555",
      title: "Unrelated work",
      cwd: "/home/u/hydra-acp",
      updatedAt: "2026-11-09T00:00:00Z",
    });
    const inTitle = sess({
      sessionId: "hydra_session_ffff6666",
      title: "Hydra summarizer",
      cwd: "/home/u/other",
      updatedAt: "2026-11-01T00:00:00Z",
    });
    expect(sessionCandidates("hydra", [inCwd, inTitle]).map((x) => x.choice)).toEqual([
      "@hydra-summarizer-ffff",
      "@unrelated-work-eeee",
    ]);
  });

  it("treats hyphens and underscores in the query as spaces", () => {
    expect(sessionCandidates("fix-login", [a, b, c]).map((x) => x.choice)).toEqual([
      "@fix-login-bug-aaaa",
    ]);
  });

  it("also matches the cwd and id, so untitled sessions are findable", () => {
    const untitled = sess({ sessionId: "hydra_session_dddd4444", title: undefined, cwd: "/home/u/auth-service" });
    expect(sessionCandidates("auth-serv", [untitled]).length).toBe(1);
    expect(sessionCandidates("dddd", [untitled]).length).toBe(1);
  });

  it("carries a session target and a labelled row", () => {
    const [first] = sessionCandidates("redesign", [b]);
    expect(first?.target).toEqual({ kind: "session", id: "hydra_session_bbbb2222", title: "Login redesign" });
    expect(first?.label).toContain("Login redesign");
    expect(first?.label).toContain("bbbb");
  });

  it("skips the current session, federated sessions and path-shaped queries", () => {
    expect(sessionCandidates("login", [a, b], { excludeId: "hydra_session_aaaa1111" }).length).toBe(1);
    expect(sessionCandidates("login", [sess({ title: "Login", remote: "peer" })]).length).toBe(0);
    expect(sessionCandidates("src/login", [a, b]).length).toBe(0);
    expect(sessionCandidates(".login", [a, b]).length).toBe(0);
  });

  it("clips a very long title in the row label", () => {
    const long = sess({ title: "x".repeat(300) });
    const [first] = sessionCandidates("xxx", [long]);
    expect(first?.label.length).toBeLessThan(120);
    expect(first?.label).toContain("...");
    expect(first?.target).toMatchObject({ title: "x".repeat(300) });
  });

  it("caps the number of rows", () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      sess({ sessionId: `hydra_session_${i}xxx0000`, title: `Login ${i}` }),
    );
    expect(sessionCandidates("login", many).length).toBe(5);
    expect(sessionCandidates("login", many, { limit: 8 }).length).toBe(8);
  });
});

import { describe, expect, it } from "vitest";
import { matchesSearch } from "./session-search.js";
import type { DiscoveredSession } from "./discovery.js";
import { normalizeTag, normalizeTags } from "../core/tags.js";

const s = (over: Partial<DiscoveredSession>): DiscoveredSession =>
  ({ sessionId: "hydra_session_x", cwd: "/w/proj", ...over }) as DiscoveredSession;

describe("matchesSearch tags", () => {
  const tagged = s({ title: "Login flow", tags: ["auth", "area/login"] });

  it("matches a tag as a plain substring", () => {
    expect(matchesSearch(tagged, "uth")).toBe(true);
  });

  it("#tag is exact, so a substring does not match", () => {
    expect(matchesSearch(tagged, "#auth")).toBe(true);
    expect(matchesSearch(tagged, "#aut")).toBe(false);
    expect(matchesSearch(tagged, "tag:auth")).toBe(true);
  });

  it("#tag matches children of a hierarchical tag", () => {
    expect(matchesSearch(tagged, "#area")).toBe(true);
    expect(matchesSearch(tagged, "#are")).toBe(false);
  });

  it("ANDs the tag token with the remaining text", () => {
    expect(matchesSearch(tagged, "#auth login")).toBe(true);
    expect(matchesSearch(tagged, "#auth nonsense")).toBe(false);
    expect(matchesSearch(s({ title: "Login", tags: [] }), "#auth login")).toBe(false);
  });
});

describe("normalizeTags", () => {
  it("lowercases, strips #, dedupes and drops invalid", () => {
    expect(normalizeTags(["#Foo", "foo", "bad tag", "", "a/b"])).toEqual(["foo", "a/b"]);
    expect(normalizeTag("-x")).toBeUndefined();
  });
});

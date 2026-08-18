import { describe, it, expect } from "vitest";
import * as os from "node:os";
import { fileLines, resolveChangesTarget } from "./sessions-changes.js";

const hit = (
  totalMatches: number,
  paths: string[],
): Parameters<typeof fileLines>[0] => ({
  sessionId: "hydra_session_x",
  cwd: "/home/u/repo",
  status: "cold",
  updatedAt: "2026-08-18T00:00:00.000Z",
  totalMatches,
  snippets: paths.map((p) => ({ kind: "edit", text: p, recordedAt: 1 })),
});

describe("resolveChangesTarget", () => {
  it("defaults to the current directory", async () => {
    expect(await resolveChangesTarget(undefined)).toBe(process.cwd());
    expect(await resolveChangesTarget("   ")).toBe(process.cwd());
  });

  it("resolves something that exists on disk to an absolute path", async () => {
    expect(await resolveChangesTarget(os.tmpdir())).toBe(os.tmpdir());
    expect(await resolveChangesTarget("~")).toBe(os.homedir());
  });

  it("passes a non-existent argument through as a segment pattern", async () => {
    // The point: `changes app.ts` must stay "app.ts" so the edit: scope
    // can match it wherever it lives, not become $PWD/app.ts.
    expect(await resolveChangesTarget("app.ts")).toBe("app.ts");
    expect(await resolveChangesTarget("src/tui/nope-not-here")).toBe(
      "src/tui/nope-not-here",
    );
  });
});

describe("fileLines", () => {
  const QUERY = "/home/u/repo/src";

  it("renders sampled paths relative to an absolute query", () => {
    const lines = fileLines(hit(2, [`${QUERY}/tui/app.ts`, `${QUERY}/cli.ts`]), undefined, QUERY);
    expect(lines).toEqual(["    2 files: tui/app.ts · cli.ts"]);
  });

  it("flags that the sample is partial", () => {
    const lines = fileLines(hit(12, [`${QUERY}/a.ts`, `${QUERY}/b.ts`]), undefined, QUERY);
    expect(lines[0]).toContain("12 files:");
    expect(lines[0]).toContain("(2 shown; --files for all)");
  });

  it("uses singular grammar for one file", () => {
    expect(fileLines(hit(1, [`${QUERY}/a.ts`]), undefined, QUERY)[0]).toBe(
      "    1 file: a.ts",
    );
  });

  it("emits nothing when a hit carries no edit snippets", () => {
    const mentionOnly = { ...hit(1, []), snippets: [{ kind: "tool-input", text: "x", recordedAt: 1 }] };
    expect(fileLines(mentionOnly, undefined, QUERY)).toEqual([]);
  });

  it("expands the full list with per-file edit counts and a new-file marker", () => {
    const lines = fileLines(
      hit(2, []),
      [
        { path: `${QUERY}/tui/app.ts`, edits: 21, created: false },
        { path: `${QUERY}/new.ts`, edits: 1, created: true },
      ],
      QUERY,
    );
    expect(lines[0]).toBe("    2 files");
    expect(lines[1]).toContain("21×  tui/app.ts");
    expect(lines[2]).toContain("1×  new.ts  (new)");
  });

  it("shows a home-shortened absolute path when the query is a bare segment", () => {
    const lines = fileLines(
      hit(1, [`${os.homedir()}/repo/src/tui/app.ts`]),
      undefined,
      "app.ts",
    );
    expect(lines[0]).toBe("    1 file: ~/repo/src/tui/app.ts");
  });
});

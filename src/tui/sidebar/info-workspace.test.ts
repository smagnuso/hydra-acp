import { describe, it, expect } from "vitest";
import { sessionInfoGadget } from "./gadgets.js";
import { emptySnapshot, type SidebarContext, type SidebarSnapshot } from "./types.js";

const ctx: SidebarContext = {
  width: 28,
  metrics: {
    cellWidth: (s) => s.length,
    truncate: (s, max) => s.slice(0, max),
  },
  border: "none",
};

const WS = { label: "feature-x", path: "/home/u/.hydra-acp/workspaces/ab12/feature-x" };

function snap(over: Partial<SidebarSnapshot> = {}): SidebarSnapshot {
  return { ...emptySnapshot(), ...over };
}

/** Flatten a gadget's rows to plain text for assertions. */
function text(s: SidebarSnapshot): string {
  return sessionInfoGadget
    .render(s, ctx)
    .map((l) => `${l.prefix ?? ""}${l.body}`)
    .join("\n");
}

describe("info gadget — workspace", () => {
  it("says nothing about workspaces for an ordinary session", () => {
    const out = text(snap({ sessionId: "abc", agent: "claude-code" }));
    expect(out).not.toMatch(/workspace|source/);
  });

  it("shows the workspace label and nothing else", () => {
    // One line, not two. The project the workspace derives from is
    // already the sessionbar's cwd field, so a `source` row here would
    // say the same thing twice.
    const out = text(snap({ sessionId: "abc", workspace: WS }));
    expect(out).toContain("feature-x");
    expect(out).toMatch(/workspace/);
    expect(out).not.toMatch(/source/);
  });

  it("renders even when nothing else is known", () => {
    // relevant() has to include the workspace, or a session whose agent
    // and model have not arrived yet would hide the one fact that changes
    // where its edits land.
    expect(
      sessionInfoGadget.relevant(snap({ workspace: { label: "solo", path: "/ws/solo" } })),
    ).toBe(true);
  });

  it("changes its version key when the workspace changes", () => {
    // The memo cache keys on this; omitting the workspace would leave a
    // stale line on screen after start or end.
    const a = snap({ sessionId: "abc" });
    const b = snap({ sessionId: "abc", workspace: WS });
    expect(sessionInfoGadget.versionKey(a, ctx)).not.toBe(sessionInfoGadget.versionKey(b, ctx));
  });
});

describe("info gadget — the workspace row is openable", () => {
  it("opens the directory rather than copying a bare label", () => {
    // A directory you can see is a directory you will try to open. Routing
    // through openPath also puts the row in the same resolution path as
    // every other clickable path, including the check that refuses a
    // workspace which no longer exists.
    const lines = sessionInfoGadget.render(snap({ sessionId: "abc", workspace: WS }), ctx);
    const opens = lines.map((l) => l.openPath).filter((p): p is string => p !== undefined);
    // Absolute, or the OSC 8 link path skips it and the open command
    // would resolve against the wrong directory.
    expect(opens).toEqual([WS.path]);
  });

  it("adds no openPath rows for an ordinary session", () => {
    const lines = sessionInfoGadget.render(snap({ sessionId: "abc", agent: "x" }), ctx);
    expect(lines.every((l) => l.openPath === undefined)).toBe(true);
  });
});

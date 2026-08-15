import { describe, expect, it } from "vitest";
import type { InputDispatcher } from "./input.js";
import { Screen, type CompactionClickTarget } from "./screen.js";
import { makeCaptureTerm } from "./bar/test-harness.js";

// Mouse behaviour for the two prompt-area modals that had none: the
// attach-time compaction prompt and the help cheatsheet. Sibling of
// permission-mouse.test.ts — the compaction prompt borrows the
// permission modal's layout, so it has to borrow its mouse rules too.
function withCompaction(): {
  screen: Screen;
  clicks: CompactionClickTarget[];
  rowOf(index: number): number;
  hintRow: number;
  row(n: number): string;
  arm(): void;
  justAppeared(): void;
} {
  const cap = makeCaptureTerm(100, 30);
  const dispatcher = {
    state: () => ({
      buffer: [""],
      row: 0,
      col: 0,
      planMode: false,
      historyIndex: 0,
      queueIndex: 0,
      attachments: [],
      historySearchQuery: null,
    }),
  } as unknown as InputDispatcher;
  const clicks: CompactionClickTarget[] = [];
  const screen = new Screen({
    term: cap.term,
    dispatcher,
    onKey: () => {},
    onCompactionClick: (t) => clicks.push(t),
    repaintThrottleMs: 0,
    progressIndicator: false,
    mouse: false,
  });
  const priv = screen as unknown as {
    started: boolean;
    compactionRowHits: Map<number, number>;
    compactionHintHits: Array<{ row: number }>;
    compactionArmedAt: number;
  };
  priv.started = true;
  screen.setCompactionPrompt({
    message: "This session has ~120k tokens of history above the watermark.",
    options: [
      { label: "Compact now", key: "y" },
      { label: "Not now", key: "n" },
    ],
    selectedIndex: 0,
  });
  screen.repaintNow();
  const byIndex = new Map<number, number>();
  for (const [row, index] of priv.compactionRowHits) {
    byIndex.set(index, row);
  }
  return {
    screen,
    clicks,
    rowOf: (index) => byIndex.get(index)!,
    hintRow: priv.compactionHintHits[0]!.row,
    row: (n) => cap.row(n),
    arm: () => {
      priv.compactionArmedAt = 0;
    },
    // The inverse. See the twin in permission-mouse.test.ts: the window
    // is real-clock, so a slow machine can spend it inside this harness
    // and arm a click a test needs dropped.
    justAppeared: () => {
      priv.compactionArmedAt = Date.now();
    },
  };
}

function mouse(screen: Screen, name: string, x: number, y: number): void {
  (
    screen as unknown as { handleMouse(name: string, data: unknown): void }
  ).handleMouse(name, { x, y });
}

function click(screen: Screen, x: number, y: number): void {
  mouse(screen, "MOUSE_LEFT_BUTTON_PRESSED", x, y);
  mouse(screen, "MOUSE_LEFT_BUTTON_RELEASED", x, y);
}

describe("compaction modal mouse", () => {
  it("hit-tests each option row and the hint words", () => {
    const c = withCompaction();
    expect(c.screen.compactionHitAt(6, c.rowOf(0))).toEqual({
      kind: "option",
      index: 0,
    });
    expect(c.screen.compactionHitAt(6, c.rowOf(1))).toEqual({
      kind: "option",
      index: 1,
    });
    // The message / question rows are inside the modal but inert.
    expect(c.screen.isCompactionCell(c.rowOf(0) - 1)).toBe(true);
    expect(c.screen.compactionHitAt(6, c.rowOf(0) - 1)).toBe(null);
    const hint = c.row(c.hintRow);
    expect(
      c.screen.compactionHitAt(hint.indexOf("⏎ submit") + 1, c.hintRow),
    ).toEqual({ kind: "hint", action: "commit" });
    expect(
      c.screen.compactionHitAt(hint.indexOf("Esc cancel") + 2, c.hintRow),
    ).toEqual({ kind: "hint", action: "cancel" });
    expect(c.screen.compactionHitAt(hint.indexOf("↑/↓") + 1, c.hintRow)).toBe(
      null,
    );
  });

  it("hovering an option selects it without submitting", () => {
    const c = withCompaction();
    mouse(c.screen, "MOUSE_MOTION", 6, c.rowOf(1));
    expect(c.clicks).toEqual([{ kind: "option", index: 1, select: true }]);
  });

  it("clicking an option submits that one", () => {
    const c = withCompaction();
    c.arm();
    click(c.screen, 6, c.rowOf(1));
    expect(c.clicks).toEqual([{ kind: "option", index: 1 }]);
  });

  it("clicking a hint word reports it", () => {
    const c = withCompaction();
    c.arm();
    const hint = c.row(c.hintRow);
    click(c.screen, hint.indexOf("Esc cancel") + 2, c.hintRow);
    expect(c.clicks).toEqual([{ kind: "hint", action: "cancel" }]);
  });

  it("wheel walks the options instead of scrolling the transcript", () => {
    const c = withCompaction();
    mouse(c.screen, "MOUSE_WHEEL_DOWN", 6, c.rowOf(0));
    expect(c.clicks).toEqual([{ kind: "option", index: 1, select: true }]);
  });

  // The prompt arrives unbidden right after attach.
  it("drops a click that lands within the arm window", () => {
    const c = withCompaction();
    c.justAppeared();
    click(c.screen, 6, c.rowOf(0));
    expect(c.clicks).toEqual([]);
    c.arm();
    click(c.screen, 6, c.rowOf(0));
    expect(c.clicks).toEqual([{ kind: "option", index: 0 }]);
  });

  it("does not submit when press and release land on different options", () => {
    const c = withCompaction();
    c.arm();
    mouse(c.screen, "MOUSE_LEFT_BUTTON_PRESSED", 6, c.rowOf(0));
    mouse(c.screen, "MOUSE_LEFT_BUTTON_RELEASED", 6, c.rowOf(1));
    expect(c.clicks).toEqual([]);
  });

  it("does not anchor a transcript selection from a click on the modal", () => {
    const c = withCompaction();
    c.arm();
    c.screen.appendLines([{ body: "selectable transcript text" }]);
    c.screen.repaintNow();
    click(c.screen, 6, c.rowOf(0));
    expect(c.screen.hasSelection()).toBe(false);
  });

  it("forgets its targets when the modal is dismissed", () => {
    const c = withCompaction();
    const row = c.rowOf(0);
    c.screen.setCompactionPrompt(null);
    expect(c.screen.isCompactionCell(row)).toBe(false);
    expect(c.screen.compactionHitAt(6, row)).toBe(null);
  });

  it("yields its click region to a permission prompt drawn on top", () => {
    const c = withCompaction();
    const row = c.rowOf(0);
    c.screen.setPermissionPrompt({
      title: "Bash(ls)",
      options: [{ label: "Allow once" }],
      selectedIndex: 0,
    });
    c.screen.repaintNow();
    expect(c.screen.isCompactionCell(row)).toBe(false);
  });
});

describe("help cheatsheet mouse", () => {
  function withHelp(): { screen: Screen; dismissals: number; row: number } {
    const cap = makeCaptureTerm(100, 30);
    const dispatcher = {
      state: () => ({
        buffer: [""],
        row: 0,
        col: 0,
        planMode: false,
        historyIndex: 0,
        queueIndex: 0,
        attachments: [],
        historySearchQuery: null,
      }),
    } as unknown as InputDispatcher;
    let dismissals = 0;
    const screen = new Screen({
      term: cap.term,
      dispatcher,
      onKey: () => {},
      onHelpClick: () => {
        dismissals++;
      },
      repaintThrottleMs: 0,
      progressIndicator: false,
      mouse: false,
    });
    const priv = screen as unknown as {
      started: boolean;
      helpRegion: { top: number; bottom: number } | null;
    };
    priv.started = true;
    screen.setHelpPrompt({
      title: "Hotkeys",
      entries: [["^G", "help"], ["^O", "options"]],
      hint: "any key dismisses",
    });
    screen.repaintNow();
    return {
      screen,
      get dismissals() {
        return dismissals;
      },
      row: priv.helpRegion!.top,
    };
  }

  it("a click on the sheet dismisses it", () => {
    const h = withHelp();
    click(h.screen, 4, h.row);
    expect(h.dismissals).toBe(1);
  });

  it("a click above the sheet leaves it up and still selects text", () => {
    const h = withHelp();
    h.screen.appendLines([{ body: "selectable transcript text" }]);
    h.screen.repaintNow();
    click(h.screen, 4, 1);
    expect(h.dismissals).toBe(0);
  });

  it("forgets its region once dismissed", () => {
    const h = withHelp();
    const row = h.row;
    h.screen.setHelpPrompt(null);
    expect(h.screen.isHelpCell(row)).toBe(false);
  });
});

import { describe, expect, it, vi } from "vitest";
import type { InputDispatcher } from "./input.js";
import { Screen, type PermissionClickTarget } from "./screen.js";
import { makeCaptureTerm } from "./bar/test-harness.js";

// Screen with a permission modal up, plus the click sink and enough
// introspection to find the rows the options landed on.
function withPermission(): {
  screen: Screen;
  clicks: PermissionClickTarget[];
  rowOf(index: number): number;
  hintRow: number;
  row(n: number): string;
  arm(): void;
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
  const clicks: PermissionClickTarget[] = [];
  const screen = new Screen({
    term: cap.term,
    dispatcher,
    onKey: () => {},
    onPermissionClick: (t) => clicks.push(t),
    repaintThrottleMs: 0,
    progressIndicator: false,
    mouse: false,
  });
  const priv = screen as unknown as {
    started: boolean;
    permissionRowHits: Map<number, number>;
    permissionHintHits: Array<{ row: number }>;
    permissionArmedAt: number;
  };
  priv.started = true;
  screen.setPermissionPrompt({
    title: "Bash(rm -rf build)",
    detail: "rm -rf build",
    options: [
      { label: "Allow once" },
      { label: "Allow always" },
      { label: "Reject" },
    ],
    selectedIndex: 0,
  });
  screen.repaintNow();
  const byIndex = new Map<number, number>();
  for (const [row, index] of priv.permissionRowHits) {
    byIndex.set(index, row);
  }
  return {
    screen,
    clicks,
    rowOf: (index) => byIndex.get(index)!,
    hintRow: priv.permissionHintHits[0]!.row,
    row: (n) => cap.row(n),
    // Pretend the modal has been up a while, so clicks are armed.
    arm: () => {
      priv.permissionArmedAt = 0;
    },
  };
}

function press(screen: Screen, x: number, y: number): void {
  (
    screen as unknown as {
      handleMouse(name: string, data: unknown): void;
    }
  ).handleMouse("MOUSE_LEFT_BUTTON_PRESSED", { x, y });
}

function release(screen: Screen, x: number, y: number): void {
  (
    screen as unknown as {
      handleMouse(name: string, data: unknown): void;
    }
  ).handleMouse("MOUSE_LEFT_BUTTON_RELEASED", { x, y });
}

function move(screen: Screen, x: number, y: number): void {
  (
    screen as unknown as {
      handleMouse(name: string, data: unknown): void;
    }
  ).handleMouse("MOUSE_MOTION", { x, y });
}

function click(screen: Screen, x: number, y: number): void {
  press(screen, x, y);
  release(screen, x, y);
}

describe("permission modal mouse", () => {
  it("hit-tests each option row and the hint words", () => {
    const p = withPermission();
    expect(p.screen.permissionHitAt(6, p.rowOf(0))).toEqual({
      kind: "option",
      index: 0,
    });
    expect(p.screen.permissionHitAt(6, p.rowOf(2))).toEqual({
      kind: "option",
      index: 2,
    });
    // The title / detail / question rows are inside the modal but inert.
    expect(p.screen.isPermissionCell(p.rowOf(0) - 1)).toBe(true);
    expect(p.screen.permissionHitAt(6, p.rowOf(0) - 1)).toBe(null);
    const hint = p.row(p.hintRow);
    expect(p.screen.permissionHitAt(hint.indexOf("⏎ submit") + 1, p.hintRow)).toEqual(
      { kind: "hint", action: "commit" },
    );
    expect(
      p.screen.permissionHitAt(hint.indexOf("Esc cancel") + 2, p.hintRow),
    ).toEqual({ kind: "hint", action: "cancel" });
    // The inert legends are not targets.
    expect(p.screen.permissionHitAt(hint.indexOf("↑/↓") + 1, p.hintRow)).toBe(null);
  });

  it("hovering an option selects it without submitting", () => {
    const p = withPermission();
    move(p.screen, 6, p.rowOf(2));
    expect(p.clicks).toEqual([{ kind: "option", index: 2, select: true }]);
  });

  it("clicking an option submits that one", () => {
    const p = withPermission();
    p.arm();
    click(p.screen, 6, p.rowOf(1));
    expect(p.clicks).toEqual([{ kind: "option", index: 1 }]);
  });

  it("clicking a hint word reports it", () => {
    const p = withPermission();
    p.arm();
    const hint = p.row(p.hintRow);
    click(p.screen, hint.indexOf("Esc cancel") + 2, p.hintRow);
    expect(p.clicks).toEqual([{ kind: "hint", action: "cancel" }]);
  });

  // A grant can't be undone, and this modal appears unbidden mid-turn, so a
  // click already travelling toward the transcript must not land on it.
  it("drops a click that lands within the arm window", () => {
    const p = withPermission();
    click(p.screen, 6, p.rowOf(1));
    expect(p.clicks).toEqual([]);
    // Hover is unaffected: it decides nothing.
    move(p.screen, 6, p.rowOf(2));
    expect(p.clicks).toEqual([{ kind: "option", index: 2, select: true }]);
    // And the click lands once the window has passed.
    p.arm();
    click(p.screen, 6, p.rowOf(1));
    expect(p.clicks).toContainEqual({ kind: "option", index: 1 });
  });

  it("does not submit when press and release land on different options", () => {
    const p = withPermission();
    p.arm();
    press(p.screen, 6, p.rowOf(0));
    release(p.screen, 6, p.rowOf(2));
    expect(p.clicks).toEqual([]);
  });

  it("does not anchor a transcript selection from a click on the modal", () => {
    const p = withPermission();
    p.arm();
    p.screen.appendLines([{ body: "selectable transcript text" }]);
    p.screen.repaintNow();
    click(p.screen, 6, p.rowOf(0));
    expect(p.screen.hasSelection()).toBe(false);
  });

  it("forgets its targets when the modal is dismissed", () => {
    const p = withPermission();
    const row = p.rowOf(0);
    p.screen.setPermissionPrompt(null);
    expect(p.screen.isPermissionCell(row)).toBe(false);
    expect(p.screen.permissionHitAt(6, row)).toBe(null);
  });
});

describe("permission arm window", () => {
  it("does not restart while the user navigates", () => {
    // The app re-pushes a spec on every arrow key. If that restarted the
    // timer, the modal would stay unclickable for as long as you kept
    // navigating.
    const p = withPermission();
    const priv = p.screen as unknown as { permissionArmedAt: number };
    const armedAt = priv.permissionArmedAt;
    vi.spyOn(Date, "now").mockReturnValue(armedAt + 5000);
    p.screen.setPermissionPrompt({
      title: "Bash(rm -rf build)",
      options: [{ label: "Allow once" }, { label: "Reject" }],
      selectedIndex: 1,
    });
    expect(priv.permissionArmedAt).toBe(armedAt);
    vi.restoreAllMocks();
  });
});

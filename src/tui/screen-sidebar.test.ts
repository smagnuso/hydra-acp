import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { thisMachine } from "../core/machine.js";
import stringWidth from "string-width";
import type { Terminal } from "terminal-kit";
import { Screen } from "./screen.js";
import type { InputDispatcher } from "./input.js";

// Blank columns between the transcript and the sidebar body; mirrors
// SIDEBAR_GUTTER in screen.ts (not exported — the tests only need to know
// where the body starts).
const SIDEBAR_GUTTER_COLS = 2;

interface Op {
  op: string;
  args: unknown[];
}

// Recording mock at a realistic size — unlike the 10x10 mock in
// screen.test.ts (which deliberately short-circuits repaint) these tests
// need the draw path to actually run so the two paint regions can be
// observed.
function makeScreen(
  width = 100,
  height = 40,
  extra: Partial<ConstructorParameters<typeof Screen>[0]> = {},
): { screen: Screen; ops: Op[]; setWidth: (w: number) => void } {
  const ops: Op[] = [];
  let w = width;
  // terminal-kit's API is callable AND chainable to arbitrary depth
  // (term("x"), term.moveTo(1,2), term.bold.noFormat("x")). The node()
  // helper builds a proxy that logs the *last* segment of the accessed
  // path when finally invoked, which is the name these assertions care
  // about ("moveTo", "eraseLineAfter", "write" for a bare call).
  const node = (name: string): ((...a: unknown[]) => unknown) =>
    new Proxy(function noop() {} as (...a: unknown[]) => unknown, {
      apply: (_t, _this, args) => {
        ops.push({ op: name, args });
        return term;
      },
      get: (_t, prop) => {
        if (prop === "width") return w;
        if (prop === "height") return height;
        return node(String(prop));
      },
    });
  const term = node("write") as unknown as Terminal;
  const dispatcher = {
    state: () => ({
      buffer: [""],
      row: 0,
      col: 0,
      planMode: false,
      historyIndex: -1,
      queueIndex: -1,
      attachments: [],
      historySearchQuery: null,
    }),
  } as unknown as InputDispatcher;
  const screen = new Screen({
    term,
    dispatcher,
    onKey: () => {},
    repaintThrottleMs: 0,
    progressIndicator: false,
    mouse: false,
    ...extra,
  });
  return { screen, ops, setWidth: (next) => (w = next) };
}

describe("Screen sidebar geometry", () => {
  it("is hidden by default and leaves the content width untouched", () => {
    const { screen } = makeScreen(100);
    expect(screen.isSidebarVisible()).toBe(false);
    expect(screen.width()).toBe(100);
  });

  it("narrows the content width when shown and restores it when hidden", () => {
    const { screen } = makeScreen(100);
    screen.setSidebarVisible(true);
    const narrowed = screen.width();
    expect(narrowed).toBeLessThan(100);
    expect(narrowed).toBeGreaterThan(50);
    screen.setSidebarVisible(false);
    expect(screen.width()).toBe(100);
  });

  it("honours a pinned width", () => {
    const { screen } = makeScreen(120);
    screen.setSidebarWidth(30);
    screen.setSidebarVisible(true);
    // 30 columns of body + the 2-column gutter + the rightmost column the
    // sidebar never writes (writing it would latch deferred-wrap and eat
    // the last glyph of every right-aligned value).
    expect(screen.width()).toBe(120 - 33);
  });

  it("never lets the sidebar take more than a third of the terminal", () => {
    const { screen } = makeScreen(90);
    screen.setSidebarWidth(70);
    screen.setSidebarVisible(true);
    expect(screen.width()).toBeGreaterThanOrEqual(Math.floor(90 * 0.6));
  });

  it("suppresses itself on a narrow terminal instead of squeezing the transcript", () => {
    const { screen } = makeScreen(70);
    screen.setSidebarVisible(true);
    expect(screen.isSidebarVisible()).toBe(true);
    expect(screen.isSidebarSuppressed()).toBe(true);
    expect(screen.width()).toBe(70);
  });

  it("un-suppresses when the terminal grows past the threshold", () => {
    const { screen, setWidth } = makeScreen(70);
    screen.setSidebarVisible(true);
    expect(screen.isSidebarSuppressed()).toBe(true);
    setWidth(120);
    expect(screen.isSidebarSuppressed()).toBe(false);
    expect(screen.width()).toBeLessThan(120);
  });

  it("toggleSidebar reports the resulting state", () => {
    const { screen } = makeScreen(100);
    expect(screen.toggleSidebar()).toBe(true);
    expect(screen.toggleSidebar()).toBe(false);
  });

  it("reports configured gadgets so callers can gate data collection", () => {
    const { screen } = makeScreen(100);
    expect(screen.isSidebarGadgetConfigured("git")).toBe(true);
    screen.setSidebarGadgets(["activity"]);
    expect(screen.isSidebarGadgetConfigured("git")).toBe(false);
  });
});

describe("Screen sidebar painting", () => {
  // repaint() brackets each frame in DEC 2026 via process.stdout; swallow
  // it so the escapes don't land in the test reporter's output.
  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // start() installs real stdin/termios plumbing we don't want in a unit
  // test; flipping `started` is enough to unblock the draw path, which is
  // all these tests exercise.
  const markStarted = (screen: Screen): void => {
    (screen as unknown as { started: boolean }).started = true;
  };

  const primed = (width = 100): { screen: Screen; ops: Op[] } => {
    const { screen, ops } = makeScreen(width);
    markStarted(screen);
    screen.appendLines([{ body: "hello transcript" }]);
    ops.length = 0;
    return { screen, ops };
  };

  // Ops carry no row/col of their own, so replay the moveTo stream to
  // attribute each subsequent op to a cell. Only the transcript rows are
  // interesting: the prompt, separators and sessionbar legitimately move
  // to other columns whether or not a sidebar exists.
  const transcriptPaintColumns = (screen: Screen, ops: Op[]): number[] => {
    const visibleRows = (
      screen as unknown as { scrollbackVisibleRows(): number }
    ).scrollbackVisibleRows();
    const cols: number[] = [];
    for (const op of ops) {
      if (op.op !== "moveTo") {
        continue;
      }
      const col = op.args[0] as number;
      const row = op.args[1] as number;
      if (row >= 1 && row <= visibleRows) {
        cols.push(col);
      }
    }
    return cols;
  };

  it("emits no sidebar columns while hidden", () => {
    const { screen, ops } = primed();
    screen.setSidebarSnapshot({ busySince: Date.now() - 1_000 });
    screen.repaintNow();
    // Every transcript row is painted from column 1; no second region.
    expect(transcriptPaintColumns(screen, ops).every((c) => c === 1)).toBe(true);
  });

  it("paints the sidebar to the right of the content region", () => {
    const { screen, ops } = primed();
    screen.setSidebarSnapshot({ busySince: Date.now() - 92_000 });
    screen.setSidebarVisible(true);
    screen.repaintNow();
    const contentWidth = screen.width();
    const cols = new Set(transcriptPaintColumns(screen, ops));
    // Exactly two regions: the transcript at column 1 and the sidebar at
    // the far side of the gutter.
    // The sidebar region starts immediately after the content region: it
    // owns its own gutter (nothing else paints those columns).
    expect([...cols].sort((a, b) => a - b)).toEqual([1, contentWidth + 1]);
  });

  it("renders live gadget content into the column", () => {
    const { screen, ops } = primed();
    screen.setSidebarVisible(true);
    screen.setSidebarSnapshot({
      busySince: Date.now() - 92_000,
      usage: { used: 43_000, size: 200_000 },
    });
    screen.repaintNow();
    // Styled text arrives via term.<style>(text), not a bare call, so
    // collect the first argument of every op rather than filtering on
    // the op name.
    const text = ops
      .map((o) => (typeof o.args[0] === "string" ? o.args[0] : ""))
      .join("|");
    expect(text).toContain("thinking");
    expect(text).toContain("1m 32s");
    expect(text).toContain("43K/200K");
  });

  it("does not erase to end of line on rows shared with the sidebar", () => {
    const { screen, ops } = primed();
    screen.setSidebarVisible(true);
    screen.setSidebarSnapshot({ busySince: Date.now() });
    screen.repaintNow();
    // Each shared row must erase at most once, from the sidebar pass.
    // (Rows below the transcript — separators, prompt, sessionbar — are
    // full width and still erase, so we can't assert a global count;
    // what matters is that no row erases twice, which would blank the
    // sidebar after painting it.)
    const erasesByRow = new Map<number, number>();
    let row = 0;
    for (const op of ops) {
      if (op.op === "moveTo") {
        row = op.args[1] as number;
      } else if (op.op === "eraseLineAfter") {
        erasesByRow.set(row, (erasesByRow.get(row) ?? 0) + 1);
      }
    }
    expect([...erasesByRow.values()].every((n) => n === 1)).toBe(true);
  });

  it("re-paints no row when a frame is identical", () => {
    const { screen, ops } = primed();
    screen.setSidebarVisible(true);
    screen.setSidebarSnapshot({ usage: { used: 1_000, size: 200_000 } });
    screen.repaintNow();
    expect(transcriptPaintColumns(screen, ops).length).toBeGreaterThan(0);
    ops.length = 0;
    screen.repaintNow();
    // repaint() still brackets the frame (hideCursor / placeCursor), but
    // no row in either region is re-emitted.
    expect(transcriptPaintColumns(screen, ops)).toEqual([]);
  });

  it("repaints only the sidebar region when only a gadget changed", () => {
    const { screen, ops } = primed();
    screen.setSidebarVisible(true);
    screen.setSidebarSnapshot({ usage: { used: 1_000, size: 200_000 } });
    screen.repaintNow();
    const contentWidth = screen.width();
    ops.length = 0;
    screen.setSidebarSnapshot({ usage: { used: 99_000, size: 200_000 } });
    screen.repaintNow();
    const cols = transcriptPaintColumns(screen, ops);
    expect(cols.length).toBeGreaterThan(0);
    // No transcript row was touched: the content region's signatures are
    // unchanged, so only the right-hand region repaints.
    expect(cols.every((c) => c === contentWidth + 1)).toBe(true);
  });

  it("reflows the transcript to the narrower width", () => {
    const { screen } = primed();
    const long = "word ".repeat(40).trim();
    for (let i = 0; i < 40; i++) {
      screen.appendLines([{ body: long }]);
    }
    screen.repaintNow();
    const rowsBefore = (
      screen as unknown as { maxScrollOffset(): number }
    ).maxScrollOffset();
    screen.setSidebarVisible(true);
    screen.repaintNow();
    const rowsAfter = (
      screen as unknown as { maxScrollOffset(): number }
    ).maxScrollOffset();
    // Narrower content region means the same text wraps into more rows.
    expect(rowsAfter).toBeGreaterThan(rowsBefore);
  });

  it("keeps clicks in the sidebar column out of transcript selection", () => {
    const { screen } = makeScreen(100);
    (screen as unknown as { started: boolean }).started = true;
    screen.appendLines([{ body: "selectable text" }]);
    screen.setSidebarVisible(true);
    screen.repaintNow();
    const contentWidth = screen.width();
    const inSidebar = screen.resolveCellToSource(contentWidth + 3, 5);
    expect(inSidebar).toBeNull();
  });
});

describe("Screen sidebar double-click to open", () => {
  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const dispatchMouse = (screen: Screen, name: string, data: unknown): void => {
    (
      screen as unknown as {
        handleMouse: (name: string, data?: unknown) => void;
      }
    ).handleMouse(name, data);
  };

  const click = (screen: Screen, x: number, y: number): void => {
    dispatchMouse(screen, "MOUSE_LEFT_BUTTON_PRESSED", { x, y });
    dispatchMouse(screen, "MOUSE_LEFT_BUTTON_RELEASED", { x, y });
  };

  // Screen with a visible sidebar carrying one git file row, plus a spy
  // standing in for the editor-spawning path so the test asserts routing
  // rather than process spawning.
  const withSidebar = (): {
    screen: Screen;
    opened: string[];
    fileRow: number;
    sidebarCol: number;
  } => {
    const { screen } = makeScreen(100, 40);
    (screen as unknown as { started: boolean }).started = true;
    const opened: string[] = [];
    (
      screen as unknown as { tryOpenPathString: (p: string) => boolean }
    ).tryOpenPathString = (p: string) => {
      opened.push(p);
      return true;
    };
    screen.setSidebarGadgets(["git"]);
    screen.setSidebarSnapshot({
      git: {
        branch: "main",
        staged: 0,
        unstaged: 1,
        untracked: 0,
        ahead: 0,
        behind: 0,
        files: [{ path: "/repo/src/a.ts", state: "dirty" }],
      },
    });
    screen.setSidebarVisible(true);
    screen.repaintNow();
    const rowPaths = (
      screen as unknown as { sidebarRowPaths: Map<number, string> }
    ).sidebarRowPaths;
    const fileRow = [...rowPaths.keys()][0]!;
    return {
      screen,
      opened,
      fileRow,
      // Click in the body, past the gutter.
      sidebarCol: screen.width() + SIDEBAR_GUTTER_COLS + 1,
    };
  };

  it("records a click target for file rows only", () => {
    const { screen, fileRow } = withSidebar();
    const rowPaths = (
      screen as unknown as { sidebarRowPaths: Map<number, string> }
    ).sidebarRowPaths;
    expect(rowPaths.get(fileRow)).toBe("/repo/src/a.ts");
    // The branch and summary rows sit directly above and carry no target.
    expect(rowPaths.size).toBe(1);
  });

  it("opens the file on the second click of a double-click", () => {
    const { screen, opened, fileRow, sidebarCol } = withSidebar();
    click(screen, sidebarCol, fileRow);
    expect(opened).toEqual([]);
    click(screen, sidebarCol, fileRow);
    expect(opened).toEqual(["/repo/src/a.ts"]);
  });

  it("treats the whole row as one target despite horizontal jitter", () => {
    const { screen, opened, fileRow, sidebarCol } = withSidebar();
    click(screen, sidebarCol, fileRow);
    click(screen, sidebarCol + 6, fileRow);
    expect(opened).toEqual(["/repo/src/a.ts"]);
  });

  it("does not open when the two clicks land on different rows", () => {
    const { screen, opened, fileRow, sidebarCol } = withSidebar();
    click(screen, sidebarCol, fileRow);
    click(screen, sidebarCol, fileRow - 1);
    expect(opened).toEqual([]);
  });

  it("does not re-open on a third click", () => {
    const { screen, opened, fileRow, sidebarCol } = withSidebar();
    click(screen, sidebarCol, fileRow);
    click(screen, sidebarCol, fileRow);
    click(screen, sidebarCol, fileRow);
    expect(opened).toEqual(["/repo/src/a.ts"]);
  });

  it("ignores a double-click on a row with no file", () => {
    const { screen, opened, fileRow, sidebarCol } = withSidebar();
    // The branch row, one above the first file row.
    click(screen, sidebarCol, fileRow - 2);
    click(screen, sidebarCol, fileRow - 2);
    expect(opened).toEqual([]);
  });

  // The gutter belongs to the sidebar region and the whole row is one
  // target, so a double-click there opens the row's file too.
  it("treats the gutter as part of the row's click target", () => {
    const { screen, opened, fileRow } = withSidebar();
    const gutter = screen.width() + 1;
    click(screen, gutter, fileRow);
    click(screen, gutter, fileRow);
    expect(opened).toEqual(["/repo/src/a.ts"]);
  });

  it("opens nothing from the gutter of a row with no file", () => {
    const { screen, opened, fileRow } = withSidebar();
    const gutter = screen.width() + 1;
    click(screen, gutter, fileRow - 2);
    click(screen, gutter, fileRow - 2);
    expect(opened).toEqual([]);
  });

  // A row carrying a typed action dispatches it through the bars' own
  // handler, so the sidebar's info rows and the sessionbar's fields are
  // one mechanism and the readonly gate stays in one place.
  it("dispatches a row's typed double-click action", () => {
    const { screen } = makeScreen(100, 40);
    (screen as unknown as { started: boolean }).started = true;
    const fired: Array<[string, string]> = [];
    (
      screen as unknown as { onBarAction: (a: string, v: string) => void }
    ).onBarAction = (a, v) => {
      fired.push([a, v]);
    };
    screen.setSidebarGadgets(["info"]);
    screen.setSidebarSnapshot({
      agent: "claude-acp",
      model: "opus[1m]",
      mode: "default",
      sessionId: "abc123",
    });
    screen.setSidebarVisible(true);
    screen.repaintNow();
    const targets = (
      screen as unknown as {
        sidebarRowDoubleActions: Map<number, { action: string; value: string }>;
      }
    ).sidebarRowDoubleActions;
    const modelRow = [...targets.entries()].find(
      ([, t]) => t.action === "choose-model",
    )![0];
    const col = screen.width() + SIDEBAR_GUTTER_COLS + 1;
    click(screen, col, modelRow);
    expect(fired).toEqual([]);
    click(screen, col, modelRow);
    expect(fired).toEqual([["choose-model", "model"]]);
  });

  // Regression: the hit maps are keyed by TERMINAL ROW, and rows move as
  // gadgets appear, paginate and scroll. Rebuilding only some of them left
  // a file row inheriting the typed action of whatever occupied that row
  // before, so double-clicking an edited file opened the agent chooser.
  it("drops typed row actions from the previous paint", () => {
    const { screen } = makeScreen(100, 40);
    (screen as unknown as { started: boolean }).started = true;
    const opened: string[] = [];
    (
      screen as unknown as { tryOpenPathString: (p: string) => boolean }
    ).tryOpenPathString = (p: string) => {
      opened.push(p);
      return true;
    };
    const fired: Array<[string, string]> = [];
    (
      screen as unknown as { onBarAction: (a: string, v: string) => void }
    ).onBarAction = (a, v) => {
      fired.push([a, v]);
    };
    // Paint the info gadget first: its rows carry choose-agent / -model /
    // -mode and land on terminal rows near the bottom of the column.
    screen.setSidebarGadgets(["info"]);
    screen.setSidebarSnapshot({
      agent: "claude-acp",
      model: "opus[1m]",
      mode: "default",
      sessionId: "abc123",
    });
    screen.setSidebarVisible(true);
    screen.repaintNow();
    const targets = (
      screen as unknown as {
        sidebarRowDoubleActions: Map<number, { action: string }>;
      }
    ).sidebarRowDoubleActions;
    expect(targets.size).toBeGreaterThan(0);
    const infoRows = [...targets.keys()];

    // Now swap in a gadget whose rows are files. Every previous target must
    // be gone, not just the ones this paint happened to overwrite.
    screen.setSidebarGadgets(["files"]);
    screen.setSidebarSnapshot({
      agent: null,
      model: null,
      mode: null,
      sessionId: null,
      editedFiles: [{ path: "/repo/Makefile", added: 3 }],
    });
    screen.repaintNow();
    expect(targets.size).toBe(0);

    const rowPaths = (
      screen as unknown as { sidebarRowPaths: Map<number, string> }
    ).sidebarRowPaths;
    const fileRow = [...rowPaths.keys()][0]!;
    const col = screen.width() + SIDEBAR_GUTTER_COLS + 1;
    click(screen, col, fileRow);
    click(screen, col, fileRow);
    // The file opens, and no chooser fires. The row it landed on is one the
    // info gadget had used, which is exactly the collision that broke.
    expect(infoRows).toContain(fileRow);
    expect(opened).toEqual(["/repo/Makefile"]);
    expect(fired).toEqual([]);
  });

  it("does not anchor a transcript selection from a sidebar click", () => {
    const { screen, fileRow, sidebarCol } = withSidebar();
    screen.appendLines([{ body: "selectable transcript text" }]);
    screen.repaintNow();
    click(screen, sidebarCol, fileRow);
    expect(
      (screen as unknown as { selectionAnchor: unknown }).selectionAnchor,
    ).toBeNull();
    expect(screen.hasSelection()).toBe(false);
  });

  it("keeps the sidebar and transcript click chains separate", () => {
    const { screen, opened, fileRow, sidebarCol } = withSidebar();
    // One click in the sidebar then one in the transcript must not
    // combine into a transcript double-click (which would word-select).
    click(screen, sidebarCol, fileRow);
    expect(
      (screen as unknown as { lastLeftClick: unknown }).lastLeftClick,
    ).toBeNull();
    expect(opened).toEqual([]);
  });

  it("forgets pending click state when the sidebar is hidden", () => {
    const { screen, opened, fileRow, sidebarCol } = withSidebar();
    click(screen, sidebarCol, fileRow);
    screen.setSidebarVisible(false);
    screen.setSidebarVisible(true);
    screen.repaintNow();
    click(screen, sidebarCol, fileRow);
    // The chain was reset, so this is a first click, not a double.
    expect(opened).toEqual([]);
  });

  it("emits an OSC 8 file:// hyperlink for absolute-path sidebar rows", () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const { screen } = makeScreen(100, 40);
    (screen as unknown as { started: boolean }).started = true;
    screen.setSidebarGadgets(["files"]);
    screen.setSidebarSnapshot({
      editedFiles: [{ path: "/repo/src/alpha.ts" }],
    });
    screen.setSidebarVisible(true);
    screen.repaintNow();
    const all = writes.join("");
    expect(all).toContain(`file://${thisMachine()}/repo/src/alpha.ts`);
    // Opener must be balanced by a closer, else the link bleeds into
    // every row painted after it.
    const openers = all.split("\x1b]8;;").length - 1;
    expect(openers).toBeGreaterThanOrEqual(2);
    expect(all).toContain("\x1b]8;;\x1b\\");
  });

  it("hyperlinks only the file name, not the glyph, delta or gap padding", () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const { screen } = makeScreen(100, 40);
    (screen as unknown as { started: boolean }).started = true;
    screen.setSidebarGadgets(["files"]);
    screen.setSidebarSnapshot({
      editedFiles: [{ path: "/repo/src/alpha.ts", added: 3, removed: 1 }],
    });
    screen.setSidebarVisible(true);
    screen.repaintNow();
    const all = writes.join("");
    const open = all.indexOf("\x1b]8;;file:");
    const close = all.indexOf("\x1b]8;;\x1b\\", open);
    expect(open).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);
    // Whatever is bracketed must not include the +/- delta or run of gap
    // spaces — that was the bug: the terminal underlined the whole row.
    const bracketed = all.slice(open, close);
    expect(bracketed).not.toContain("+3");
    expect(bracketed).not.toContain("-1");
    expect(bracketed).not.toMatch(/ {3}/);
  });

  it("does not hyperlink sidebar rows whose path is not absolute", () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const { screen } = makeScreen(100, 40);
    (screen as unknown as { started: boolean }).started = true;
    screen.setSidebarGadgets(["files"]);
    screen.setSidebarSnapshot({ editedFiles: [{ path: "src/rel.ts" }] });
    screen.setSidebarVisible(true);
    screen.repaintNow();
    expect(writes.join("")).not.toContain("\x1b]8;;");
  });

  it("reports whether an editor command is configured", () => {
    const { screen } = makeScreen(100);
    expect(screen.hasOpenFileCommand()).toBe(false);
  });
});

describe("Screen sidebar scrolling", () => {
  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const wheel = (screen: Screen, dir: "UP" | "DOWN", x: number, y: number): void => {
    (
      screen as unknown as {
        handleMouse: (name: string, data?: unknown) => void;
      }
    ).handleMouse(`MOUSE_WHEEL_${dir}`, { x, y });
  };

  const scrollState = (
    screen: Screen,
  ): { offset: number; overflow: number } => screen.sidebarScrollState();

  // Transcript scroll offset lives in a private field; the sidebar tests
  // only need to assert it didn't move.
  const transcriptOffset = (screen: Screen): number =>
    (screen as unknown as { scrollOffset: number }).scrollOffset;

  // A column taller than the terminal: a long plan plus a long file list
  // on a short screen guarantees overflow.
  const tall = (height = 14): { screen: Screen; sidebarCol: number } => {
    const { screen } = makeScreen(100, height);
    (screen as unknown as { started: boolean }).started = true;
    screen.setSidebarSnapshot({
      busySince: Date.now(),
      usage: { used: 1_000, size: 200_000 },
      plan: Array.from({ length: 12 }, (_, i) => ({
        content: `task ${i}`,
        status: "pending" as const,
      })),
      editedFiles: Array.from({ length: 6 }, (_, i) => ({
        path: `/repo/f${i}.ts`,
      })),
      sessionId: "abc12345",
      agent: "claude-code",
      model: "sonnet",
    });
    screen.setSidebarVisible(true);
    screen.repaintNow();
    return { screen, sidebarCol: screen.width() + 3 };
  };

  const short = (): { screen: Screen; sidebarCol: number } => {
    const { screen } = makeScreen(100, 40);
    (screen as unknown as { started: boolean }).started = true;
    screen.setSidebarGadgets(["activity"]);
    screen.setSidebarSnapshot({ busySince: Date.now() });
    screen.setSidebarVisible(true);
    screen.repaintNow();
    return { screen, sidebarCol: screen.width() + 3 };
  };

  it("reports overflow when the column is taller than the terminal", () => {
    const { screen } = tall();
    expect(scrollState(screen).overflow).toBeGreaterThan(0);
    expect(scrollState(screen).offset).toBe(0);
  });

  it("reports no overflow for a column that fits", () => {
    const { screen } = short();
    expect(scrollState(screen).overflow).toBe(0);
  });

  it("scrolls the column under the wheel", () => {
    const { screen, sidebarCol } = tall();
    wheel(screen, "DOWN", sidebarCol, 3);
    expect(scrollState(screen).offset).toBe(3);
    wheel(screen, "UP", sidebarCol, 3);
    expect(scrollState(screen).offset).toBe(0);
  });

  it("clamps at both ends", () => {
    const { screen, sidebarCol } = tall();
    for (let i = 0; i < 40; i++) {
      wheel(screen, "DOWN", sidebarCol, 3);
    }
    const { offset, overflow } = scrollState(screen);
    expect(offset).toBe(overflow);
    for (let i = 0; i < 40; i++) {
      wheel(screen, "UP", sidebarCol, 3);
    }
    expect(scrollState(screen).offset).toBe(0);
  });

  it("leaves the transcript alone while scrolling the sidebar", () => {
    const { screen, sidebarCol } = tall();
    for (let i = 0; i < 60; i++) {
      screen.appendLines([{ body: `transcript line ${i}` }]);
    }
    screen.repaintNow();
    const before = transcriptOffset(screen);
    wheel(screen, "DOWN", sidebarCol, 3);
    expect(scrollState(screen).offset).toBeGreaterThan(0);
    expect(transcriptOffset(screen)).toBe(before);
  });

  it("scrolls the transcript when the wheel is over the transcript", () => {
    const { screen } = tall();
    for (let i = 0; i < 60; i++) {
      screen.appendLines([{ body: `transcript line ${i}` }]);
    }
    screen.repaintNow();
    wheel(screen, "UP", 5, 3);
    expect(transcriptOffset(screen)).toBeGreaterThan(0);
    expect(scrollState(screen).offset).toBe(0);
  });

  it("falls through to the transcript when the column has nothing hidden", () => {
    const { screen, sidebarCol } = short();
    for (let i = 0; i < 60; i++) {
      screen.appendLines([{ body: `transcript line ${i}` }]);
    }
    screen.repaintNow();
    wheel(screen, "UP", sidebarCol, 3);
    expect(transcriptOffset(screen)).toBeGreaterThan(0);
  });

  it("scrolls from the gutter too, where the indicator arrows live", () => {
    const { screen } = tall();
    wheel(screen, "DOWN", screen.width() + 1, 3);
    expect(scrollState(screen).offset).toBeGreaterThan(0);
  });

  it("re-clamps when the column shrinks under a scrolled offset", () => {
    const { screen, sidebarCol } = tall();
    for (let i = 0; i < 40; i++) {
      wheel(screen, "DOWN", sidebarCol, 3);
    }
    expect(scrollState(screen).offset).toBeGreaterThan(0);
    // The plan clearing removes most of the column's height.
    screen.setSidebarSnapshot({ plan: [], editedFiles: [] });
    screen.repaintNow();
    const { offset, overflow } = scrollState(screen);
    expect(overflow).toBeLessThan(3);
    // Re-clamped to whatever the new maximum is, rather than left pointing
    // past the end of a column that just got much shorter.
    expect(offset).toBe(overflow);
  });

  it("resets the offset when the sidebar is hidden", () => {
    const { screen, sidebarCol } = tall();
    wheel(screen, "DOWN", sidebarCol, 3);
    expect(scrollState(screen).offset).toBe(3);
    screen.setSidebarVisible(false);
    expect(scrollState(screen).offset).toBe(0);
  });

  it("paints scroll indicators only in the directions with hidden rows", () => {
    // Overflow now has to come from the number of GADGETS, not the length of
    // one list: the list gadgets paginate, so no single gadget can outgrow
    // the column on its own.
    const { screen, ops } = makeScreen(100, 14);
    (screen as unknown as { started: boolean }).started = true;
    screen.setSidebarSnapshot({
      busySince: Date.now(),
      usage: { used: 43_000, size: 200_000, costAmount: 1.5 },
      queued: 2,
      plan: Array.from({ length: 12 }, (_, i) => ({
        content: `task ${i}`,
        status: "pending" as const,
      })),
      editedFiles: [{ path: "/repo/a.ts" }, { path: "/repo/b.ts" }],
      sessionId: "abc12345",
      agent: "opencode",
      model: "sonnet",
      mode: "build",
    });
    screen.setSidebarVisible(true);
    const painted = (): string => {
      ops.length = 0;
      screen.fullRedraw();
      return ops
        .map((o) => (typeof o.args[0] === "string" ? o.args[0] : ""))
        .join("");
    };
    // At the top of the column: a down arrow only.
    const top = painted();
    expect(top).toContain("\u25bc");
    expect(top).not.toContain("\u25b2");
    // Scrolled into the middle: both directions have hidden rows.
    wheel(screen, "DOWN", screen.width() + 3, 3);
    const middle = painted();
    expect(middle).toContain("\u25b2");
    expect(middle).toContain("\u25bc");
  });
});

describe("Screen sidebar column edges", () => {
  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const painted = (
    screen: Screen,
    ops: Op[],
  ): { rows: Map<number, string>; maxCol: number } => {
    ops.length = 0;
    screen.fullRedraw();
    // maxCol tracks only the SIDEBAR region. The separators and the
    // sessionbar span the full terminal width and have their own
    // last-column conventions; this is about the column we added.
    const sidebarStart = screen.width() + 1;
    const rows = new Map<number, string>();
    let row = 0;
    let col = 1;
    let inSidebar = false;
    let maxCol = 0;
    for (const op of ops) {
      if (op.op === "moveTo") {
        col = op.args[0] as number;
        row = op.args[1] as number;
        inSidebar = col >= sidebarStart;
        continue;
      }
      const text = typeof op.args[0] === "string" ? op.args[0] : "";
      if (text === "") {
        continue;
      }
      if (inSidebar) {
        rows.set(row, (rows.get(row) ?? "") + text);
        col += stringWidth(text);
        maxCol = Math.max(maxCol, col - 1);
      }
    }
    return { rows, maxCol };
  };

  const busy = (height = 40): { screen: Screen; ops: Op[] } => {
    const { screen, ops } = makeScreen(100, height);
    (screen as unknown as { started: boolean }).started = true;
    screen.setSidebarGadgets(["activity"]);
    screen.setSidebarSnapshot({ busySince: Date.now() - 92_000 });
    screen.setSidebarVisible(true);
    return { screen, ops };
  };

  // Regression: the body used to run to the final terminal column, which
  // latches deferred-wrap and drops the last glyph — the "s" of "1m 32s".
  it("never writes the rightmost terminal column", () => {
    const { screen, ops } = busy();
    const { maxCol } = painted(screen, ops);
    expect(maxCol).toBeLessThanOrEqual(99);
  });

  it("keeps the elapsed unit visible at the right edge", () => {
    const { screen, ops } = busy();
    const { rows } = painted(screen, ops);
    const activity = [...rows.values()].find((r) => r.includes("thinking"));
    expect(activity).toBeDefined();
    expect(activity).toContain("1m 32s");
  });

  it("anchors the column at the top, not the bottom", () => {
    const { screen, ops } = busy();
    const { rows } = painted(screen, ops);
    // Row 1 is the first transcript row; the sidebar's first content row
    // shares it. Anything below the gadget stack is blank padding.
    const firstNonBlank = [...rows.entries()]
      .filter(([, text]) => text.trim() !== "")
      .map(([row]) => row)
      .sort((a, b) => a - b)[0];
    expect(firstNonBlank).toBe(1);
    // With the default top-capped border, row 1 is the cap and the first
    // gadget's content sits directly under it.
    expect(rows.get(1)).toContain("┌");
    expect(rows.get(2)).toContain("thinking");
  });

  it("paints the framed border by default", () => {
    const { screen, ops } = busy();
    const { rows } = painted(screen, ops);
    const all = [...rows.values()].join("\n");
    // Opening cap, vertical edge, and a closing rule delineating the bottom.
    expect(all).toContain("┌");
    expect(all).toContain("│");
    expect(all).toContain("└");
  });

  it("drops to a plain vertical rule on request", () => {
    const { screen, ops } = busy();
    screen.setSidebarBorder("rule");
    const all = [...painted(screen, ops).rows.values()].join("\n");
    expect(all).toContain("│");
    expect(all).not.toContain("┌");
    expect(all).not.toContain("└");
  });

  it("drops the rules in 'none' mode", () => {
    const { screen, ops } = busy();
    screen.setSidebarBorder("none");
    const { rows } = painted(screen, ops);
    const sidebarText = [...rows.values()].join("\n");
    expect(sidebarText).not.toContain("└");
    expect(sidebarText).not.toContain("┌");
    expect(sidebarText).not.toContain("├");
    expect(sidebarText).not.toContain("│");
  });
});

// Two ways the column and the transcript leaked into each other once the
// scrollback stopped calling eraseLineAfter and started padding its own
// region instead.
// Columns a string actually occupies on screen. An inline SGR span
// (ESC[1m ... ESC[0m) is zero-width once rendered, so counting the raw
// bytes overstates the width by exactly the escapes, which is the mistake
// the code under test used to make.
const visibleWidth = (text: string): number =>
  stringWidth(text.replace(/\x1b\[[0-9;]*m/g, ""));

describe("Screen region isolation", () => {
  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Last row of the shared (transcript + sidebar) region. Derived rather
  // than hardcoded: the bottom chrome's height depends on prompt rows,
  // chips and zones, so a literal bound silently stops testing anything.
  const lastSharedRow = (screen: Screen): number =>
    (screen as unknown as { scrollbackVisibleRows(): number }).scrollbackVisibleRows();

  const prepared = (): { screen: Screen; ops: Op[] } => {
    const { screen, ops } = makeScreen(100, 20);
    (screen as unknown as { started: boolean }).started = true;
    screen.setSidebarGadgets(["activity"]);
    screen.setSidebarSnapshot({ busySince: Date.now() });
    screen.setSidebarVisible(true);
    return { screen, ops };
  };

  // Segment widths per row, split by which region the cursor was moved to.
  const regionWrites = (
    screen: Screen,
    ops: Op[],
  ): { content: Map<number, number>; sidebarRows: Set<number> } => {
    const start = screen.width() + 1;
    const content = new Map<number, number>();
    const sidebarRows = new Set<number>();
    let row = 0;
    let inSidebar = false;
    for (const op of ops) {
      if (op.op === "moveTo") {
        const col = op.args[0] as number;
        row = op.args[1] as number;
        inSidebar = col >= start;
        continue;
      }
      const text = typeof op.args[0] === "string" ? op.args[0] : "";
      if (text === "") {
        continue;
      }
      if (inSidebar) {
        sidebarRows.add(row);
      } else {
        content.set(row, (content.get(row) ?? 0) + visibleWidth(text));
      }
    }
    return { content, sidebarRows };
  };

  // Inline SGR spans are zero-width once rendered, so measuring the body
  // WITHOUT stripping them understated the pad and left the tail of the row
  // holding the previous frame's glyphs.
  it("pads a span-bearing row out to the full content width", () => {
    const { screen, ops } = prepared();
    screen.appendLines([
      { body: "plain text here", bodyStyle: "agent" },
      {
        body: "with \x1b[1mbold\x1b[0m and \x1b[96mcode\x1b[0m spans",
        bodyStyle: "agent",
      },
    ]);
    ops.length = 0;
    screen.fullRedraw();
    const { content } = regionWrites(screen, ops);
    const w = screen.width();
    const bound = lastSharedRow(screen);
    const transcriptRows = [...content.entries()].filter(
      ([row]) => row <= bound,
    );
    expect(transcriptRows.length).toBeGreaterThan(0);
    // Every transcript row fills its region exactly: no short row (which
    // would leave residue) and no overrun (which would invade the sidebar).
    for (const [, width] of transcriptRows) {
      expect(width).toBe(w);
    }
  });

  it("pads blank transcript rows to the full content width", () => {
    const { screen, ops } = prepared();
    screen.appendLines([{ body: "one line" }]);
    ops.length = 0;
    screen.fullRedraw();
    const { content } = regionWrites(screen, ops);
    const bound = lastSharedRow(screen);
    for (const [row, width] of content) {
      if (row <= bound) {
        expect(width).toBe(screen.width());
      }
    }
  });

  // ANSI bodies are not character-truncated at paint time (that's the bug
  // the ansi path exists to avoid), so the guarantee has to come from the
  // wrap: wrapOne hard-wraps them to the CURRENT content width on every
  // frame. Pinning it here because the alternative — a clamp in the paint
  // path — is what I reached for first, and it would have been unreachable
  // code in the hottest loop in the file.
  it("keeps a long ansi row inside the content region", () => {
    const { screen, ops } = prepared();
    screen.appendLines([
      { body: `\u001b[32m${"x".repeat(400)}\u001b[39m`, ansi: true },
    ]);
    ops.length = 0;
    screen.fullRedraw();
    const { content, sidebarRows } = regionWrites(screen, ops);
    const bound = lastSharedRow(screen);
    const rows = [...content.entries()].filter(([row]) => row <= bound);
    expect(rows.length).toBeGreaterThan(0);
    for (const [, width] of rows) {
      expect(width).toBeLessThanOrEqual(screen.width());
    }
    // And every shared row it touched had the column re-asserted over it,
    // which is what makes any future overrun self-healing within the frame.
    for (const [row] of rows) {
      expect(sidebarRows.has(row)).toBe(true);
    }
  });

  it("repaints the sidebar row when the transcript row it shares changed", () => {
    const { screen, ops } = prepared();
    screen.appendLines([{ body: "first" }]);
    screen.fullRedraw();
    ops.length = 0;
    // Transcript-only change: the sidebar snapshot is untouched.
    // appendLines repaints synchronously at throttle 0, so the ops it
    // emits are the frame under test — a later repaintNow would find
    // nothing left to do.
    screen.appendLines([{ body: "second" }]);
    const { content, sidebarRows } = regionWrites(screen, ops);
    const changed = [...content.keys()].filter((r) => r <= lastSharedRow(screen));
    expect(changed.length).toBeGreaterThan(0);
    // Every transcript row that was re-emitted had its sidebar counterpart
    // re-asserted over it.
    for (const row of changed) {
      expect(sidebarRows.has(row)).toBe(true);
    }
  });

  it("still emits nothing for a wholly unchanged frame", () => {
    const { screen, ops } = prepared();
    screen.appendLines([{ body: "stable" }]);
    screen.fullRedraw();
    ops.length = 0;
    screen.repaintNow();
    const { content, sidebarRows } = regionWrites(screen, ops);
    const bound = lastSharedRow(screen);
    expect([...content.keys()].filter((r) => r <= bound)).toEqual([]);
    expect([...sidebarRows].filter((r) => r <= bound)).toEqual([]);
  });
});

// Past a certain width, reflowing the transcript around the column costs
// more than it gives: prose rewrapped into the smaller half of the screen
// is harder to read than prose with its right-hand side temporarily
// covered. Past half the terminal the column floats over the transcript
// instead, and the transcript keeps its geometry — so dismissing the
// sidebar restores the previous view exactly rather than reflowing again.
describe("Screen sidebar overlay mode", () => {
  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const withWidth = (
    pinned: number | null,
    termWidth = 100,
  ): { screen: Screen; ops: Op[] } => {
    const { screen, ops } = makeScreen(termWidth, 24);
    (screen as unknown as { started: boolean }).started = true;
    screen.setSidebarGadgets(["activity"]);
    screen.setSidebarSnapshot({ busySince: Date.now() });
    screen.setSidebarWidth(pinned);
    screen.setSidebarVisible(true);
    return { screen, ops };
  };

  it("reflows for an ordinary column", () => {
    const { screen } = withWidth(null);
    expect(screen.isSidebarOverlay()).toBe(false);
    expect(screen.width()).toBeLessThan(100);
  });

  it("overlays once the column wants more than half the terminal", () => {
    const { screen } = withWidth(60);
    expect(screen.isSidebarOverlay()).toBe(true);
    // The transcript keeps the full width: nothing re-wraps.
    expect(screen.width()).toBe(100);
  });

  it("switches modes at the halfway boundary", () => {
    // 46 body + 2 gutter + 1 reserved = 49, just under half of 100.
    expect(withWidth(46).screen.isSidebarOverlay()).toBe(false);
    // 48 body + 3 = 51, just over.
    expect(withWidth(48).screen.isSidebarOverlay()).toBe(true);
  });

  it("does not reflow the transcript when overlaying", () => {
    const { screen } = withWidth(null);
    const long = "word ".repeat(60).trim();
    for (let i = 0; i < 30; i++) {
      screen.appendLines([{ body: long }]);
    }
    screen.setSidebarVisible(false);
    const unreflowed = (
      screen as unknown as { maxScrollOffset(): number }
    ).maxScrollOffset();
    screen.setSidebarWidth(60);
    screen.setSidebarVisible(true);
    expect(screen.isSidebarOverlay()).toBe(true);
    expect(
      (screen as unknown as { maxScrollOffset(): number }).maxScrollOffset(),
    ).toBe(unreflowed);
  });

  it("still reflows in the narrow case, for contrast", () => {
    const { screen } = withWidth(null);
    const long = "word ".repeat(60).trim();
    for (let i = 0; i < 30; i++) {
      screen.appendLines([{ body: long }]);
    }
    screen.setSidebarVisible(false);
    const before = (
      screen as unknown as { maxScrollOffset(): number }
    ).maxScrollOffset();
    screen.setSidebarVisible(true);
    expect(
      (screen as unknown as { maxScrollOffset(): number }).maxScrollOffset(),
    ).toBeGreaterThan(before);
  });

  it("paints the column at the right edge in both modes", () => {
    for (const pinned of [null, 60]) {
      const { screen, ops } = withWidth(pinned);
      ops.length = 0;
      screen.fullRedraw();
      const cols = new Set(
        ops
          .filter((o) => o.op === "moveTo")
          .map((o) => o.args[0] as number)
          .filter((c) => c > 1),
      );
      const start = (
        screen as unknown as { sidebarColumnStart(): number }
      ).sidebarColumnStart();
      expect([...cols]).toContain(start);
    }
  });

  it("lets the transcript keep eraseLineAfter when overlaying", () => {
    const { screen, ops } = withWidth(60);
    screen.appendLines([{ body: "hello" }]);
    ops.length = 0;
    screen.fullRedraw();
    // Both regions erase: the transcript owns the whole line here, and the
    // column repaints over it afterwards.
    expect(ops.filter((o) => o.op === "eraseLineAfter").length).toBeGreaterThan(
      0,
    );
  });

  it("keeps the column on top of the transcript row it covers", () => {
    const { screen, ops } = withWidth(60);
    screen.appendLines([{ body: "x".repeat(200) }]);
    ops.length = 0;
    screen.fullRedraw();
    const start = (
      screen as unknown as { sidebarColumnStart(): number }
    ).sidebarColumnStart();
    // For row 1, the last moveTo must be the sidebar's: it paints after the
    // transcript, so its cells win.
    const row1 = ops
      .filter((o) => o.op === "moveTo" && (o.args[1] as number) === 1)
      .map((o) => o.args[0] as number);
    expect(row1.at(-1)).toBe(start);
  });

  it("does not resolve clicks under the overlay to hidden transcript text", () => {
    const { screen } = withWidth(60);
    screen.appendLines([{ body: "y".repeat(200) }]);
    screen.fullRedraw();
    const start = (
      screen as unknown as { sidebarColumnStart(): number }
    ).sidebarColumnStart();
    // Bottom-most transcript row: content is bottom-anchored, so the top
    // rows are blank padding that resolves to nothing in either mode.
    const row = (
      screen as unknown as { scrollbackVisibleRows(): number }
    ).scrollbackVisibleRows();
    // Left of the column: real transcript text, resolvable.
    expect(screen.resolveCellToSource(start - 2, row)).not.toBeNull();
    // Under the column: laid out but invisible, so not selectable.
    expect(screen.resolveCellToSource(start + 4, row)).toBeNull();
  });

  it("never covers the whole terminal, however wide the pin", () => {
    const { screen } = withWidth(500);
    expect(screen.width()).toBe(100);
    const start = (
      screen as unknown as { sidebarColumnStart(): number }
    ).sidebarColumnStart();
    expect(start).toBeGreaterThan(1);
    expect(
      (screen as unknown as { transcriptVisibleWidth(): number }).transcriptVisibleWidth(),
    ).toBeGreaterThanOrEqual(12);
  });
});

describe("Screen sidebar pager clicks", () => {
  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const click = (screen: Screen, x: number, y: number): void => {
    const dispatch = (name: string): void =>
      (
        screen as unknown as {
          handleMouse: (n: string, d?: unknown) => void;
        }
      ).handleMouse(name, { x, y });
    dispatch("MOUSE_LEFT_BUTTON_PRESSED");
    dispatch("MOUSE_LEFT_BUTTON_RELEASED");
  };

  type PagerAction = {
    start: number;
    end: number;
    gadget: string;
    index?: number;
    collapse?: true;
  };

  const rowActions = (screen: Screen): Map<number, PagerAction[]> =>
    (
      screen as unknown as { sidebarRowActions: Map<number, PagerAction[]> }
    ).sidebarRowActions;

  // Cell of the arrow that jumps to `target`, as currently painted. Re-read
  // after every click: which arrows exist depends on the page you're on.
  const arrowTo = (
    screen: Screen,
    target: number,
  ): { x: number; y: number } | null => {
    for (const [row, list] of rowActions(screen)) {
      for (const a of list) {
        if (a.index === target) {
          return { x: a.start, y: row };
        }
      }
    }
    return null;
  };

  // A column that genuinely cannot fit its list, which is now the only way
  // to get a pager at all: a short terminal plus far more files than rows.
  // (On a tall terminal the same list renders complete, with no pager —
  // that's the point of the fitting pass, and it's covered below.)
  const paged = (): Screen => {
    const { screen } = makeScreen(100, 14);
    (screen as unknown as { started: boolean }).started = true;
    screen.setSidebarGadgets(["files"]);
    screen.setSidebarSnapshot({
      editedFiles: Array.from({ length: 40 }, (_, i) => ({
        path: `/repo/f${i}.ts`,
      })),
    });
    screen.setSidebarVisible(true);
    screen.fullRedraw();
    return screen;
  };

  const page = (screen: Screen): number => screen.sidebarPageState().files ?? 0;

  it("pages forward on a single click of the forward arrow", () => {
    const screen = paged();
    expect(page(screen)).toBe(0);
    const next = arrowTo(screen, 1)!;
    click(screen, next.x, next.y);
    expect(page(screen)).toBe(1);
  });

  it("pages back again", () => {
    const screen = paged();
    const next = arrowTo(screen, 1)!;
    click(screen, next.x, next.y);
    const back = arrowTo(screen, 0)!;
    click(screen, back.x, back.y);
    expect(page(screen)).toBe(0);
  });

  it("offers no back arrow on the first page", () => {
    expect(arrowTo(paged(), -1)).toBeNull();
    // Page 0 offers exactly one arrow: forward. (The title row also
    // carries the fold toggle, which is not an arrow.)
    const screen = paged();
    expect(
      [...rowActions(screen).values()]
        .flat()
        .filter((a) => a.collapse !== true),
    ).toHaveLength(1);
  });

  it("stops at the last page, with no forward arrow there", () => {
    const screen = paged();
    // Page count depends on the fitted page size, so walk forward until the
    // forward arrow disappears rather than assuming a count.
    for (let i = 0; i < 50; i++) {
      const forward = arrowTo(screen, page(screen) + 1);
      if (forward === null) {
        break;
      }
      click(screen, forward.x, forward.y);
    }
    expect(page(screen)).toBeGreaterThan(0);
    expect(arrowTo(screen, page(screen) + 1)).toBeNull();
    // The back arrow is still there on the last page.
    expect(arrowTo(screen, page(screen) - 1)).not.toBeNull();
  });

  it("offers both arrows on a middle page", () => {
    const screen = paged();
    click(screen, arrowTo(screen, 1)!.x, arrowTo(screen, 1)!.y);
    expect(
      [...rowActions(screen).values()]
        .flat()
        .filter((a) => a.collapse !== true),
    ).toHaveLength(2);
  });

  // Clicking a gadget's title folds it to that one row. The point is not
  // only screen space: app.ts gates the gadget's polling on
  // isSidebarGadgetActive, so a folded git block stops spawning `git
  // status` and a folded resources block stops walking /proc.
  it("folds a gadget when its title row is clicked, and unfolds it again", () => {
    const screen = paged();
    const titleRow = [...rowActions(screen)]
      .flatMap(([row, list]) => list.map((a) => ({ row, a })))
      .find(({ a }) => a.collapse === true)!;
    expect(titleRow).toBeDefined();
    // File rows are the ones carrying open paths, so the map's size is a
    // direct count of the list rows on screen.
    const openable = (): number =>
      (screen as unknown as { sidebarRowPaths: Map<number, string> })
        .sidebarRowPaths.size;
    expect(openable()).toBeGreaterThan(0);

    click(screen, titleRow.a.start, titleRow.row);
    expect(screen.sidebarCollapsedIds()).toEqual(["files"]);
    expect(screen.isSidebarGadgetActive("files")).toBe(false);
    // Still configured — folding is a view state, not a deconfiguration.
    expect(screen.isSidebarGadgetConfigured("files")).toBe(true);
    // Nothing of the list survives the fold.
    expect(openable()).toBe(0);

    click(screen, titleRow.a.start, titleRow.row);
    expect(screen.sidebarCollapsedIds()).toEqual([]);
    expect(screen.isSidebarGadgetActive("files")).toBe(true);
    expect(openable()).toBeGreaterThan(0);
  });

  it("reports the fold through onSidebarCollapseChange", () => {
    const seen: Array<[string, boolean]> = [];
    const { screen } = makeScreen(100, 14, {
      onSidebarCollapseChange: (g, c) => seen.push([g, c]),
    });
    (screen as unknown as { started: boolean }).started = true;
    screen.setSidebarGadgets(["files"]);
    screen.setSidebarSnapshot({ editedFiles: [{ path: "/repo/a.ts" }] });
    screen.setSidebarVisible(true);
    screen.fullRedraw();
    screen.toggleSidebarGadgetCollapsed("files");
    screen.toggleSidebarGadgetCollapsed("files");
    expect(seen).toEqual([
      ["files", true],
      ["files", false],
    ]);
  });

  it("ignores a click next to the arrow", () => {
    const screen = paged();
    const next = arrowTo(screen, 1)!;
    click(screen, next.x - 2, next.y);
    expect(page(screen)).toBe(0);
  });

  it("does not open a file when clicking the pager row", () => {
    const screen = paged();
    const opened: string[] = [];
    (
      screen as unknown as { tryOpenPathString: (p: string) => boolean }
    ).tryOpenPathString = (p) => {
      opened.push(p);
      return true;
    };
    const next = arrowTo(screen, 1)!;
    click(screen, next.x, next.y);
    // A second click on what is now the back arrow's row must still not be
    // read as a double-click-to-open.
    click(screen, next.x, next.y);
    expect(opened).toEqual([]);
  });

  it("forgets pages when the sidebar is hidden", () => {
    const screen = paged();
    const next = arrowTo(screen, 1)!;
    click(screen, next.x, next.y);
    expect(screen.sidebarPageState().files).toBe(1);
    screen.setSidebarVisible(false);
    expect(screen.sidebarPageState().files).toBeUndefined();
  });
});

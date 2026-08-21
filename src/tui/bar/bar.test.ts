import { describe, expect, it, vi } from "vitest";
import stringWidth from "string-width";
import type { InputDispatcher } from "../input.js";
import { Screen } from "../screen.js";
import type { BarSideConfig } from "../../core/config.js";
import { expandSide } from "./slots.js";
import { DEFAULT_HINT_ITEMS } from "./types.js";
import type { BarLayoutConfig } from "./types.js";
import { makeCaptureTerm } from "./test-harness.js";

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

const HOME = process.env["HOME"] ?? "/home/x";

interface Rows {
  top: string;
  bottom: string;
  sessionbar: string;
  screen: Screen;
}

function render(
  width: number,
  opts: {
    bar?: BarLayoutConfig;
    session?: Record<string, unknown>;
    banner?: Record<string, unknown>;
  } = {},
): Rows {
  const height = 24;
  const cap = makeCaptureTerm(width, height);
  const screen = new Screen({
    term: cap.term,
    dispatcher,
    onKey: () => {},
    repaintThrottleMs: 0,
    progressIndicator: false,
    mouse: false,
  });
  const priv = screen as unknown as Record<string, unknown> & {
    drawBar(slot: string, row: number): void;
  };
  priv["started"] = true;
  if (opts.bar) {
    screen.setBarConfig(opts.bar);
  }
  screen.setSessionbar({
    agent: "claude",
    model: "claude-sonnet-4-5-20250929",
    cwd: `${HOME}/dev/hydra-acp/cli`,
    sessionId: "hydra-a1b2c3d4e5",
    title: "make the sessionbar configurable",
    usage: { used: 12_400, size: 200_000, costAmount: 0.31, costCurrency: "USD" },
    ...opts.session,
  });
  // No `hint` override: the shipped DEFAULT_HINT_ITEMS is what these
  // rows should be asserting against. The old fixture carried its own
  // prose copy, which had drifted from the real glyphs (`^p` vs `⌃P`).
  screen.setBanner({
    status: "busy",
    elapsedMs: 62_000,
    queued: 2,
    ...opts.banner,
  });
  // Setters above schedule their own repaints; drop whatever they
  // emitted, and the row-signature cache with it, so the explicit
  // draws below actually reach the terminal.
  cap.reset();
  (priv["painter"] as { clearCache(): void }).clearCache();
  priv.drawBar("composerTop", 1);
  priv.drawBar("composerBottom", 2);
  priv.drawBar("sessionbar", height);
  return {
    top: cap.row(1),
    bottom: cap.row(2),
    sessionbar: cap.row(height),
    screen,
  };
}

describe("chrome bars", () => {
  // The shipped defaults must reproduce what the three hand-rolled draw
  // methods produced before the layout engine existed. These strings
  // were captured from the pre-refactor code.
  it("default layout matches the pre-refactor output at 120 columns", () => {
    const r = render(120);
    expect(r.top).toBe(
      "── Thinking 1m 2s · hydra-a1b2c3d4e5 · 2 queued ──────────────────────────────────────────────── 12.4k/200.0k · $0.31 ──",
    );
    expect(r.sessionbar).toBe(
      "~/dev/hydra-acp/cli · make the sessionbar configurable                                claude•claude-sonnet-4-5-20250929",
    );
  });

  it("default layout matches the pre-refactor output at 80 columns", () => {
    const r = render(80);
    expect(r.top).toBe(
      "── Thinking 1m 2s · hydra-a1b2c3d4e5 · 2 queued ──────── 12.4k/200.0k · $0.31 ──",
    );
    expect(r.sessionbar).toBe(
      "~/dev/hydra-acp/cli · make the sessionbar co… claude•claude-sonnet-4-5-20250929",
    );
  });

  it("default layout matches the pre-refactor output at 60 columns", () => {
    const r = render(60);
    expect(r.sessionbar).toBe(
      "~/dev/hydra-a… · make th… claude•claude-sonnet-4-5-20250929",
    );
  });

  // The old bottom separator painted a " · " before the *first* hint
  // chunk while sizing the row as if it were not there, so the row ran
  // three columns past the terminal and wrapped.
  it("bottom rule no longer emits a leading separator", () => {
    const r = render(120);
    expect(r.bottom).toBe(
      "─────────────────────────────────────────────────────────────── ⇧⇥ mode · ⌃O options · ⌃P pick · ⌃G guide · ⌃D detach ──",
    );
    expect(r.bottom).not.toContain("── · ");
  });

  // The pre-refactor rules did not truncate at all: at 40 columns the
  // top rule was 67 cells wide and the sessionbar 46.
  it.each([200, 120, 100, 80, 72, 60, 50, 40, 30, 24, 20])(
    "never exceeds the terminal width (w=%i)",
    (w) => {
      const r = render(w);
      expect(stringWidth(r.top)).toBeLessThanOrEqual(w);
      expect(stringWidth(r.bottom)).toBeLessThanOrEqual(w);
      // The sessionbar deliberately leaves the last column unwritten.
      expect(stringWidth(r.sessionbar)).toBeLessThanOrEqual(w - 1);
    },
  );

  it("sheds low-priority fields before high-priority ones", () => {
    const r = render(40);
    // Status survives (priority Infinity); the session id does not.
    expect(r.top).toContain("Thinking");
    expect(r.top).not.toContain("hydra-a1b2c3d4e5");
  });

  it("sheds hint chunks right-to-left rather than all at once", () => {
    const r = render(40);
    expect(r.bottom).toContain("⇧⇥ mode");
    expect(r.bottom).not.toContain("detach");
  });

  it("shrinks flex fields before shedding them", () => {
    // cwd has a lower priority than title but is flex, so at 60 columns
    // both survive in truncated form rather than cwd vanishing.
    const r = render(60);
    expect(r.sessionbar).toContain("~/dev/hydra-a…");
    expect(r.sessionbar).toContain("make th…");
  });

  it("drops absent fields and their separators", () => {
    const r = render(120, {
      session: { title: undefined, usage: undefined },
      banner: { queued: 0, status: "ready", elapsedMs: undefined },
    });
    expect(r.top).toBe(
      `── Ready · hydra-a1b2c3d4e5 ${"─".repeat(120 - 28)}`,
    );
    expect(r.sessionbar).not.toContain("·");
  });

  // The agent handed the turn back but a job it started is still going.
  // Not "Thinking" (nothing is) and not plain "Ready" (it can restart
  // itself), so it gets its own word, clocked from when the job started
  // rather than from the turn end.
  it("renders Waiting while a background task is armed", () => {
    const r = render(120, {
      session: { title: undefined, usage: undefined },
      banner: {
        queued: 0,
        status: "ready",
        elapsedMs: undefined,
        armedSince: Date.now() - 62_000,
      },
    });
    expect(r.top).toContain("Waiting 1m 2s");
    expect(r.top).not.toContain("Ready");
    expect(r.top).not.toContain("Thinking");
  });

  it("prefers Thinking over Waiting when a turn is actually in flight", () => {
    const r = render(120, {
      session: { title: undefined, usage: undefined },
      banner: {
        queued: 0,
        status: "busy",
        elapsedMs: 62_000,
        armedSince: Date.now() - 600_000,
      },
    });
    expect(r.top).toContain("Thinking 1m 2s");
    expect(r.top).not.toContain("Waiting");
  });

  it("returns to Ready once the armed task clears", () => {
    const r = render(120, {
      session: { title: undefined, usage: undefined },
      banner: { queued: 0, status: "ready", elapsedMs: undefined },
    });
    expect(r.top).toContain("Ready");
    expect(r.top).not.toContain("Waiting");
  });

  it("records click ranges for the hint chunks", () => {
    const w = 120;
    const r = render(w);
    const col = r.bottom.indexOf("⌃P pick") + 1;
    expect(r.screen.bannerHitAt(col, 2)).toBe("pick");
    expect(r.screen.bannerHitAt(col, 1)).toBe(null);
    expect(r.screen.bannerHitAt(1, 2)).toBe(null);
  });

  it("honours a custom slot configuration", () => {
    const bar: BarLayoutConfig = {
      composer: {
        top: { left: ["agent", "model"], right: ["cost"] },
        bottom: { left: [{ text: "hello" }], right: [] },
      },
      sessionbar: { left: ["sessionId"], right: ["tokens"] },
    };
    const r = render(80, { bar });
    expect(r.top).toContain("claude · claude-sonnet-4-5-20250929");
    expect(r.top).toContain("$0.31");
    expect(r.top).not.toContain("Thinking");
    expect(r.bottom.startsWith(" hello ")).toBe(true);
    expect(r.sessionbar).toContain("hydra-a1b2c3d4e5");
    expect(r.sessionbar).toContain("12.4k/200.0k");
  });

  it("applies per-entry maxWidth and prefix/suffix overrides", () => {
    const bar: BarLayoutConfig = {
      composer: {
        top: { left: ["status"], right: [] },
        bottom: { left: [], right: [] },
      },
      sessionbar: {
        left: [{ field: "cwd", maxWidth: 10, prefix: "[", suffix: "]" }],
        right: [],
      },
    };
    const r = render(80, { bar });
    expect(r.sessionbar.trimEnd()).toBe("[~/dev/hyd…]");
  });

  it("ignores unknown field ids instead of blanking the row", () => {
    const bar: BarLayoutConfig = {
      composer: {
        top: { left: ["nope", "status"], right: [] },
        bottom: { left: [], right: [] },
      },
      sessionbar: { left: ["cwd"], right: [] },
    };
    const r = render(80, { bar });
    expect(r.top.startsWith("── Thinking ")).toBe(true);
  });

  // The notification channel is force-rendered over composer.bottom.right
  // rather than being a field, so emptying that side cannot switch it off.
  it("transient content replaces the hints", () => {
    const w = 120;
    const cap = makeCaptureTerm(w, 24);
    const screen = new Screen({
      term: cap.term,
      dispatcher,
      onKey: () => {},
      repaintThrottleMs: 0,
      progressIndicator: false,
      mouse: false,
    });
    const priv = screen as unknown as Record<string, unknown> & {
      drawBar(slot: string, row: number): void;
    };
    priv["started"] = true;
    screen.setBanner({
      status: "ready",
      queued: 0,
      hint: DEFAULT_HINT_ITEMS.slice(0, 2),
    });
    screen.setBannerSearchIndicator("needle");
    cap.reset();
    (priv["painter"] as { clearCache(): void }).clearCache();
    priv.drawBar("composerBottom", 2);
    expect(cap.row(2)).not.toContain("⌃P pick");
    expect(cap.row(2)).toContain("needle");
  });

  // Entering a workspace provisions a checkout, may run a dependency
  // install, and then respawns the agent. Without a persistent
  // indicator the composer looks idle for the whole minute, which is
  // when people press Enter again.
  it("shows workspace progress, and shows it over compaction", () => {
    const cap = makeCaptureTerm(120, 24);
    const screen = new Screen({
      term: cap.term,
      dispatcher,
      onKey: () => {},
      repaintThrottleMs: 0,
      progressIndicator: false,
      mouse: false,
    });
    const priv = screen as unknown as Record<string, unknown> & {
      drawBar(slot: string, row: number): void;
    };
    priv["started"] = true;
    screen.setBanner({
      status: "ready",
      queued: 0,
      hint: DEFAULT_HINT_ITEMS.slice(0, 2),
    });
    screen.setCompactionIndicator("compacting...");
    screen.setWorkspaceIndicator("running workspace setup...");
    cap.reset();
    (priv["painter"] as { clearCache(): void }).clearCache();
    priv.drawBar("composerBottom", 2);
    expect(cap.row(2)).toContain("running workspace setup...");
    expect(cap.row(2)).not.toContain("compacting...");

    // Cleared on the terminal phase, and whatever was underneath resumes.
    screen.setWorkspaceIndicator(null);
    cap.reset();
    (priv["painter"] as { clearCache(): void }).clearCache();
    priv.drawBar("composerBottom", 2);
    expect(cap.row(2)).toContain("compacting...");
  });

  it("still shows notifications when composer.bottom.right is empty", () => {
    const cap = makeCaptureTerm(120, 24);
    const screen = new Screen({
      term: cap.term,
      dispatcher,
      onKey: () => {},
      repaintThrottleMs: 0,
      progressIndicator: false,
      mouse: false,
    });
    const priv = screen as unknown as Record<string, unknown> & {
      drawBar(slot: string, row: number): void;
    };
    priv["started"] = true;
    screen.setBarConfig({
      composer: {
        top: { left: ["status"], right: [] },
        bottom: { left: [], right: [] },
      },
      sessionbar: { left: [], right: [] },
    });
    cap.reset();
    (priv["painter"] as { clearCache(): void }).clearCache();
    priv.drawBar("composerBottom", 2);
    expect(cap.row(2).trimEnd()).toBe("─".repeat(118) + "──");

    screen.setBannerSearchIndicator("needle");
    cap.reset();
    (priv["painter"] as { clearCache(): void }).clearCache();
    priv.drawBar("composerBottom", 2);
    expect(cap.row(2)).toContain("needle");
  });

  it("displaces configured content on the bottom rule while live", () => {
    const cap = makeCaptureTerm(120, 24);
    const screen = new Screen({
      term: cap.term,
      dispatcher,
      onKey: () => {},
      repaintThrottleMs: 0,
      progressIndicator: false,
      mouse: false,
    });
    const priv = screen as unknown as Record<string, unknown> & {
      drawBar(slot: string, row: number): void;
    };
    priv["started"] = true;
    screen.setBarConfig({
      composer: {
        top: { left: [], right: [] },
        bottom: { left: [], right: ["cwd", "agentModel"] },
      },
      sessionbar: { left: [], right: [] },
    });
    screen.setSessionbar({ agent: "claude", cwd: "/tmp/x", sessionId: "s1" });
    screen.setBannerSearchIndicator("needle");
    cap.reset();
    (priv["painter"] as { clearCache(): void }).clearCache();
    priv.drawBar("composerBottom", 2);
    expect(cap.row(2)).toContain("needle");
    expect(cap.row(2)).not.toContain("/tmp/x");
  });

  it("does not leak the channel onto the other rows", () => {
    const cap = makeCaptureTerm(120, 24);
    const screen = new Screen({
      term: cap.term,
      dispatcher,
      onKey: () => {},
      repaintThrottleMs: 0,
      progressIndicator: false,
      mouse: false,
    });
    const priv = screen as unknown as Record<string, unknown> & {
      drawBar(slot: string, row: number): void;
    };
    priv["started"] = true;
    screen.setSessionbar({ agent: "claude", cwd: "/tmp/x", sessionId: "s1" });
    screen.setBannerSearchIndicator("needle");
    cap.reset();
    (priv["painter"] as { clearCache(): void }).clearCache();
    priv.drawBar("composerTop", 1);
    priv.drawBar("sessionbar", 24);
    expect(cap.row(1)).not.toContain("needle");
    expect(cap.row(24)).not.toContain("needle");
  });

  it("is not an addressable field id", () => {
    // Listing it in config used to be required; now it resolves to
    // nothing so an old config degrades to the forced behaviour.
    const cap = makeCaptureTerm(120, 24);
    const screen = new Screen({
      term: cap.term,
      dispatcher,
      onKey: () => {},
      repaintThrottleMs: 0,
      progressIndicator: false,
      mouse: false,
    });
    const priv = screen as unknown as Record<string, unknown> & {
      drawBar(slot: string, row: number): void;
    };
    priv["started"] = true;
    screen.setBarConfig({
      composer: {
        top: { left: ["transient"], right: [] },
        bottom: { left: [], right: [] },
      },
      sessionbar: { left: [], right: [] },
    });
    screen.setBannerSearchIndicator("needle");
    cap.reset();
    (priv["painter"] as { clearCache(): void }).clearCache();
    priv.drawBar("composerTop", 1);
    expect(cap.row(1)).not.toContain("needle");
  });
});

// The hints are onboarding: past tui.composer.hintTurns prompts they
// dissolve into the rule, and two gestures bring them back.
describe("help-hint onboarding", () => {
  interface HintPriv extends Record<string, unknown> {
    drawBar(slot: string, row: number): void;
    handleKey(name: string, data: { isCharacter?: boolean }): void;
    handleMouse(name: string, data?: unknown): void;
  }

  const ROW = 2;

  function harness(opts: { exhausted?: boolean; width?: number } = {}): {
    screen: Screen;
    priv: HintPriv;
    bottom: () => string;
    /** A column inside the hint zone, and one on the rule but left of it. */
    inZone: number;
    outOfZone: number;
    zoneStart: () => number | null;
  } {
    const width = opts.width ?? 120;
    const cap = makeCaptureTerm(width, 24);
    const screen = new Screen({
      term: cap.term,
      dispatcher,
      onKey: () => {},
      repaintThrottleMs: 0,
      progressIndicator: false,
      mouse: false,
    });
    const priv = screen as unknown as HintPriv;
    priv["started"] = true;
    screen.setBanner({
      status: "ready",
      queued: 0,
      hintsExhausted: opts.exhausted ?? true,
    });
    // Repainting the row is also what tells the reveal which row the rule
    // is on, so every assertion goes through here.
    const bottom = (): string => {
      cap.reset();
      (priv["painter"] as { clearCache(): void }).clearCache();
      priv.drawBar("composerBottom", ROW);
      return cap.row(ROW);
    };
    return {
      screen,
      priv,
      bottom,
      // The zone runs to the right edge of the row, so the last few
      // columns are always inside it and column 5 never is.
      inZone: width - 2,
      outOfZone: 5,
      zoneStart: () => priv["hintZoneStart"] as number | null,
    };
  }

  it("shows the hints while the session is still new", () => {
    expect(harness({ exhausted: false }).bottom()).toContain("⌃O options");
  });

  // Resolving to nothing rather than to a placeholder glyph is what keeps
  // this seamless: with no right-side group there are no pad spaces, so
  // the fill runs the whole width instead of leaving two holes in it.
  it("collapses to an unbroken rule, with no gap where the pads were", () => {
    const row = harness().bottom();
    expect(row).not.toContain("⇧⇥ mode");
    expect(row).toBe("─".repeat(120));
  });

  // CTRL_LEFT is in terminal-kit's xterm keymap but not in mapKeyName, so
  // it reaches handleKey and is dropped — the realistic unbound chord.
  // Not reproducible through scripts/tui-capture.mjs: tmux sets TERM to
  // screen-*, terminal-kit has no termconfig for it and falls back to
  // none.js, whose keymap has no CTRL_* entries at all.
  it("brings them back for a Ctrl chord that maps to nothing", () => {
    const { priv, bottom } = harness();
    priv.handleKey("CTRL_LEFT", {});
    expect(bottom()).toContain("⌃O options");
  });

  it("retires the keyboard reveal once a prompt has been sent", () => {
    const { screen, priv, bottom } = harness();
    priv.handleKey("CTRL_LEFT", {});
    expect(bottom()).toContain("⌃O options");
    screen.clearHintReveal();
    expect(bottom()).not.toContain("⌃O options");
  });

  // A turn retires a parked pointer's reveal too, rather than leaving the
  // row up for as long as the mouse happens to sit on it.
  it("retires a hover reveal on a prompt, and re-reveals on the next move", () => {
    const { screen, priv, bottom, inZone } = harness();
    bottom();
    priv.handleMouse("MOUSE_MOTION", { x: inZone, y: ROW });
    expect(bottom()).toContain("⌃O options");
    screen.clearHintReveal();
    expect(bottom()).not.toContain("⌃O options");
    // Pointer never left the zone, so the next motion event there brings
    // the hints back — no stuck state.
    priv.handleMouse("MOUSE_MOTION", { x: inZone - 1, y: ROW });
    expect(bottom()).toContain("⌃O options");
  });

  it("does not reveal for a chord that is bound to something", () => {
    const { priv, bottom } = harness();
    priv.handleKey("CTRL_P", {});
    expect(bottom()).not.toContain("⌃O options");
  });

  // Reveal is resolved by a span, not by hit region: once expanded, the pad
  // column between the fill and the first chunk has no hit region, and a
  // hover keyed on regions would collapse there, re-expand, and oscillate.
  it("reveals from any column in the zone, hit region or not", () => {
    const { priv, bottom, inZone } = harness();
    const collapsed = bottom();
    expect(collapsed).not.toContain("⇧⇥ mode");

    priv.handleMouse("MOUSE_MOTION", { x: inZone, y: ROW });
    const expanded = bottom();
    expect(expanded).toContain("⌃O options");

    // indexOf gives the 0-based index of the first hint glyph, which is
    // the 1-based column of the pad space in front of it.
    const padColumn = expanded.indexOf("⇧⇥ mode");
    priv.handleMouse("MOUSE_MOTION", { x: padColumn, y: ROW });
    expect(bottom()).toContain("⌃O options");
  });

  // The rest of the rule is a long way from the hints and is not a target
  // for them: crossing the fill on the way to the composer left it flapping.
  it("ignores the fill and the left side of the rule", () => {
    const { priv, bottom, outOfZone, zoneStart } = harness();
    const collapsed = bottom();
    expect(collapsed).not.toContain("⌃O options");

    priv.handleMouse("MOUSE_MOTION", { x: outOfZone, y: ROW });
    expect(bottom()).not.toContain("⌃O options");

    // One column short of the zone still counts as outside it.
    const start = zoneStart();
    expect(start).not.toBeNull();
    priv.handleMouse("MOUSE_MOTION", { x: start! - 1, y: ROW });
    expect(bottom()).not.toContain("⌃O options");
    priv.handleMouse("MOUSE_MOTION", { x: start!, y: ROW });
    expect(bottom()).toContain("⌃O options");
  });

  // A transient message displaces the whole right side for its duration, so
  // there is nothing a reveal could bring back while one is up. Self-healing:
  // the next motion after it clears re-evaluates.
  it("has no zone while a transient owns the right side", () => {
    const { screen, priv, bottom, inZone, zoneStart } = harness();
    screen.setBannerSearchIndicator("needle");
    expect(bottom()).toContain("needle");
    expect(zoneStart()).toBeNull();
    priv.handleMouse("MOUSE_MOTION", { x: inZone, y: ROW });
    expect(bottom()).not.toContain("⌃O options");

    screen.setBannerSearchIndicator(null);
    bottom();
    priv.handleMouse("MOUSE_MOTION", { x: inZone, y: ROW });
    expect(bottom()).toContain("⌃O options");
  });

  // The zone is measured from the revealed layout, so it is already the
  // wide one while collapsed. If it were measured from the collapsed row it
  // would jump on reveal and the pointer would fall outside what it just
  // opened.
  it("keeps the same zone before and after the reveal", () => {
    const { priv, bottom, inZone, zoneStart } = harness();
    bottom();
    const collapsedZone = zoneStart();
    priv.handleMouse("MOUSE_MOTION", { x: inZone, y: ROW });
    expect(bottom()).toContain("⌃O options");
    expect(zoneStart()).toBe(collapsedZone);
  });

  // Leaving hides on a delay so that crossing the zone on the way to
  // something else doesn't flap the row.
  it("collapses again once the pointer has been outside the zone for the grace period", () => {
    vi.useFakeTimers();
    try {
      const { priv, bottom, inZone, outOfZone } = harness();
      bottom();
      priv.handleMouse("MOUSE_MOTION", { x: inZone, y: ROW });
      expect(bottom()).toContain("⌃O options");
      priv.handleMouse("MOUSE_MOTION", { x: outOfZone, y: ROW });
      expect(bottom()).toContain("⌃O options");
      vi.runAllTimers();
      expect(bottom()).not.toContain("⌃O options");
    } finally {
      vi.useRealTimers();
    }
  });

  // Every motion is preceded by a paint: drawBars from the previous event
  // re-anchors the rule to its real layout row, and the harness paints at
  // ROW. See the bottom() comment.
  it("cancels the pending hide when the pointer comes back", () => {
    vi.useFakeTimers();
    try {
      const { priv, bottom, inZone } = harness();
      bottom();
      priv.handleMouse("MOUSE_MOTION", { x: inZone, y: ROW });
      expect(bottom()).toContain("⌃O options");
      priv.handleMouse("MOUSE_MOTION", { x: inZone, y: ROW + 1 });
      expect(bottom()).toContain("⌃O options");
      priv.handleMouse("MOUSE_MOTION", { x: inZone, y: ROW });
      vi.runAllTimers();
      expect(bottom()).toContain("⌃O options");
    } finally {
      vi.useRealTimers();
    }
  });

  // The pointer sitting outside the zone when the turn lands must not leave
  // an armed timer behind to collapse a *later* keyboard reveal out from
  // under the user.
  it("does not let a stale hide timer retire a later keyboard reveal", () => {
    vi.useFakeTimers();
    try {
      const { screen, priv, bottom, inZone, outOfZone } = harness();
      bottom();
      priv.handleMouse("MOUSE_MOTION", { x: inZone, y: ROW });
      expect(bottom()).toContain("⌃O options");
      priv.handleMouse("MOUSE_MOTION", { x: outOfZone, y: ROW });
      screen.clearHintReveal();
      priv.handleKey("CTRL_LEFT", {});
      vi.runAllTimers();
      expect(bottom()).toContain("⌃O options");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps ⌃O when the row is too narrow for the whole list", () => {
    // Shed order is positional, so options sits second to survive.
    const row = harness({ exhausted: false, width: 40 }).bottom();
    expect(row).toContain("⇧⇥ mode");
    expect(row).toContain("⌃O options");
    expect(row).not.toContain("detach");
  });
});

describe("chrome bar mouse", () => {
  // Everything painted from a field is a hit region, on all three rows.
  // Before this the only click targets in the whole chrome were the four
  // hint chunks on the composer bottom rule.
  it("registers hit regions on every row, sessionbar included", () => {
    const r = render(120);
    const col = r.sessionbar.indexOf("~/dev") + 1;
    const hit = r.screen.barHitAt(col, 24);
    expect(hit?.id).toBe("sessionbar:cwd");
    expect(hit?.doubleAction).toBe("open");
  });

  it("carries the underlying value, not the painted text", () => {
    // cwd paints "~/dev/…" but must open the absolute path.
    const r = render(120);
    const hit = r.screen.barHitAt(r.sessionbar.indexOf("~/dev") + 1, 24);
    expect(hit?.value).toBe(`${HOME}/dev/hydra-acp/cli`);
    const sid = r.screen.barHitAt(r.top.indexOf("hydra-a1b2") + 1, 1);
    expect(sid?.value).toBe("hydra-a1b2c3d4e5");
    expect(sid?.doubleAction).toBe("copy");
  });

  it("copies the session id it shows, prefix stripped", () => {
    // Pasting hydra_session_… is a nuisance and buys nothing: every
    // consumer (the daemon's resolveCanonicalId, /session <id>, the
    // picker) re-attaches the prefix itself.
    const r = render(120, {
      session: { sessionId: "hydra_session_a1b2c3d4e5f6g7h8" },
    });
    const sid = r.screen.barHitAt(r.top.indexOf("a1b2c3d4") + 1, 1);
    expect(sid?.value).toBe("a1b2c3d4e5f6g7h8");
    expect(sid?.doubleAction).toBe("copy");
  });

  it("opens the rename field on a double-click of the title", () => {
    const r = render(120);
    const hit = r.screen.barHitAt(r.sessionbar.indexOf("make the") + 1, 24);
    expect(hit?.id).toBe("sessionbar:title");
    expect(hit?.doubleAction).toBe("rename-session");
    // Seeds the field from the full title even when the bar truncated it.
    const narrow = render(50);
    const trunc = narrow.screen.barHitAt(
      narrow.sessionbar.indexOf("make th") + 1,
      24,
    );
    expect(narrow.sessionbar).toContain("make th…");
    expect(trunc?.value).toBe("make the sessionbar configurable");
  });

  it("opens the model chooser from the combined agent•model field", () => {
    const r = render(120);
    // The shipped sessionbar default is one chunk covering both, and model
    // is the dimension people switch.
    const hit = r.screen.barHitAt(r.sessionbar.indexOf("claude•") + 1, 24);
    expect(hit?.id).toBe("sessionbar:agentModel");
    expect(hit?.doubleAction).toBe("choose-model");
  });

  it("wires the mode / agent / model fields to their choosers", () => {
    const bar: BarLayoutConfig = {
      composer: {
        top: { left: ["mode"], right: [] },
        bottom: { left: [], right: [] },
      },
      sessionbar: { left: ["agent"], right: ["model"] },
    };
    const r = render(80, { bar, banner: { currentMode: "plan" } });
    // `mode` picks from the chooser like the other two. It deliberately no
    // longer cycles on a single click: one chunk can't do both, since the
    // first click of a double would have already changed the mode.
    const mode = r.screen.barHitAt(r.top.indexOf("plan") + 1, 1);
    expect(mode?.action).toBe("none");
    expect(mode?.doubleAction).toBe("choose-mode");
    expect(
      r.screen.barHitAt(r.sessionbar.indexOf("claude") + 1, 24)?.doubleAction,
    ).toBe("choose-agent");
    expect(
      r.screen.barHitAt(r.sessionbar.indexOf("claude-sonnet") + 1, 24)
        ?.doubleAction,
    ).toBe("choose-model");
  });

  it("keeps the hint chunks wired to their application effects", () => {
    const r = render(120);
    const at = (needle: string): string | undefined =>
      r.screen.barHitAt(r.bottom.indexOf(needle) + 1, 2)?.action;
    expect(at("⇧⇥ mode")).toBe("toggle-mode");
    expect(at("⌃O options")).toBe("toggle-options");
    expect(at("⌃P pick")).toBe("switch-session");
    expect(at("⌃G guide")).toBe("show-help");
    expect(at("⌃D detach")).toBe("detach");
  });

  it("returns null off any field", () => {
    const r = render(120);
    // The fill run between the two sides belongs to no field.
    expect(r.screen.barHitAt(60, 1)).toBe(null);
    expect(r.screen.barHitAt(1, 5)).toBe(null);
  });

  it("honours onClick / onDoubleClick overrides from config", () => {
    const bar: BarLayoutConfig = {
      composer: {
        top: { left: [{ field: "status", onClick: "show-help" }], right: [] },
        bottom: { left: [], right: [] },
      },
      sessionbar: {
        left: [{ field: "cwd", onDoubleClick: "copy" }],
        right: [],
      },
    };
    const r = render(80, { bar });
    expect(r.screen.barHitAt(4, 1)?.action).toBe("show-help");
    expect(r.screen.barHitAt(1, 24)?.doubleAction).toBe("copy");
  });

  it("rejects an unrecognised action name rather than crashing", () => {
    const bar: BarLayoutConfig = {
      composer: {
        top: { left: [{ field: "status", onClick: "rm -rf" }], right: [] },
        bottom: { left: [], right: [] },
      },
      sessionbar: { left: [], right: [] },
    };
    const r = render(80, { bar });
    expect(r.screen.barHitAt(4, 1)?.action).toBe("none");
  });

  it("hit regions survive a repaint that the signature cache skips", () => {
    const r = render(120);
    const priv = r.screen as unknown as { drawBar(s: string, n: number): void };
    priv.drawBar("sessionbar", 24);
    expect(r.screen.barHitAt(1, 24)?.id).toBe("sessionbar:cwd");
  });
});

describe("chrome bar gestures", () => {
  interface Priv {
    handleBarPress(c: { x: number; y: number }): boolean;
    handleBarRelease(c: { x: number; y: number } | null): boolean;
    tryOpenPathString(raw: string): boolean;
    notify(msg: string): void;
  }

  function gestures(width = 120): { r: Rows; priv: Priv; actions: string[][] } {
    const r = render(width);
    const actions: string[][] = [];
    (r.screen as unknown as Record<string, unknown>)["onBarAction"] = (
      a: string,
      v: string,
    ) => actions.push([a, v]);
    return { r, priv: r.screen as unknown as Priv, actions };
  }

  it("fires the click action only when press and release agree", () => {
    const { r, priv, actions } = gestures();
    const x = r.bottom.indexOf("⌃P pick") + 1;
    expect(priv.handleBarPress({ x, y: 2 })).toBe(true);
    expect(priv.handleBarRelease({ x, y: 2 })).toBe(true);
    expect(actions).toEqual([["switch-session", "⌃P pick"]]);
  });

  it("ignores a press-drag-release that lands on a different field", () => {
    const { r, priv, actions } = gestures();
    const from = r.bottom.indexOf("⌃P pick") + 1;
    const to = r.bottom.indexOf("⌃G guide") + 1;
    priv.handleBarPress({ x: from, y: 2 });
    expect(priv.handleBarRelease({ x: to, y: 2 })).toBe(false);
    expect(actions).toEqual([]);
  });

  it("claims the gesture on an inert field so it can't start a selection", () => {
    const { r, priv, actions } = gestures();
    const x = r.top.indexOf("Thinking") + 1;
    expect(priv.handleBarPress({ x, y: 1 })).toBe(true);
    expect(priv.handleBarRelease({ x, y: 1 })).toBe(true);
    expect(actions).toEqual([]);
  });

  it("double-click on cwd opens the absolute path", () => {
    const { r, priv } = gestures();
    const opened: string[] = [];
    priv.tryOpenPathString = (raw) => {
      opened.push(raw);
      return true;
    };
    const x = r.sessionbar.indexOf("~/dev") + 1;
    priv.handleBarPress({ x, y: 24 });
    priv.handleBarRelease({ x, y: 24 });
    priv.handleBarPress({ x, y: 24 });
    expect(opened).toEqual([`${HOME}/dev/hydra-acp/cli`]);
  });

  it("reports when there is no openFileCommand to open with", () => {
    const { r, priv } = gestures();
    const notes: string[] = [];
    priv.notify = (m) => notes.push(m);
    const x = r.sessionbar.indexOf("~/dev") + 1;
    priv.handleBarPress({ x, y: 24 });
    priv.handleBarRelease({ x, y: 24 });
    priv.handleBarPress({ x, y: 24 });
    expect(notes).toEqual(["no tui.openFileCommand configured"]);
  });

  it("a slow second click is not a double-click", async () => {
    const { r, priv } = gestures();
    const opened: string[] = [];
    priv.tryOpenPathString = (raw) => {
      opened.push(raw);
      return true;
    };
    const x = r.sessionbar.indexOf("~/dev") + 1;
    priv.handleBarPress({ x, y: 24 });
    priv.handleBarRelease({ x, y: 24 });
    // Rewind the chain tip past the double-click window.
    (r.screen as unknown as { lastBarClick: { id: string; t: number } })
      .lastBarClick.t -= 10_000;
    priv.handleBarPress({ x, y: 24 });
    expect(opened).toEqual([]);
  });

  it("a double-click split across two different fields is two singles", () => {
    const { r, priv, actions } = gestures();
    const pick = r.bottom.indexOf("⌃P pick") + 1;
    const guide = r.bottom.indexOf("⌃G guide") + 1;
    priv.handleBarPress({ x: pick, y: 2 });
    priv.handleBarRelease({ x: pick, y: 2 });
    priv.handleBarPress({ x: guide, y: 2 });
    priv.handleBarRelease({ x: guide, y: 2 });
    expect(actions).toEqual([
      ["switch-session", "⌃P pick"],
      ["show-help", "⌃G guide"],
    ]);
  });
});

// The frame above the btw overlay was a fourth hand-rolled row painting
// the same three things as composer.top (a status label, a session id, a
// usage readout) against the fork's data. It now renders composer.top's
// slot config through a substituted context.
describe("btw frame", () => {
  function renderBtw(
    width: number,
    meta: { sessionId?: string | null; usage?: Record<string, number> } = {
      sessionId: "hydra-f0f0f0f0",
      usage: { used: 8200, size: 200_000, costAmount: 0.12 },
    },
  ): { row: string; screen: Screen } {
    const cap = makeCaptureTerm(width, 24);
    const screen = new Screen({
      term: cap.term,
      dispatcher,
      onKey: () => {},
      repaintThrottleMs: 0,
      progressIndicator: false,
      mouse: false,
    });
    const priv = screen as unknown as Record<string, unknown> & {
      drawBar(slot: string, row: number): void;
    };
    priv["started"] = true;
    screen.setBtwOverlayMeta(meta);
    cap.reset();
    (priv["painter"] as { clearCache(): void }).clearCache();
    priv.drawBar("btw", 3);
    return { row: cap.row(3), screen };
  }

  it("reproduces the hand-rolled header layout", () => {
    const { row } = renderBtw(80);
    expect(row).toBe(
      "── By the way · hydra-f0f0f0f0 ────────────────────────── 8.2k/200.0k · $0.12 ──",
    );
  });

  it("omits the session id block when no fork id is known", () => {
    const { row } = renderBtw(80, { sessionId: null, usage: {} });
    expect(row.startsWith("── By the way ─")).toBe(true);
    expect(row).not.toContain(" · ");
  });

  it("shows the fork's usage, not the session's", () => {
    const { row } = renderBtw(80);
    expect(row).toContain("8.2k/200.0k");
    expect(row).not.toContain("12.4k");
  });

  it("makes the fork id a single-click jump target", () => {
    const { row, screen } = renderBtw(80);
    const hit = screen.barHitAt(row.indexOf("hydra-f0") + 1, 3);
    expect(hit?.action).toBe("open-session");
    expect(hit?.value).toBe("hydra-f0f0f0f0");
  });

  it("still honours a customised composer.top on the frame", () => {
    const cap = makeCaptureTerm(80, 24);
    const screen = new Screen({
      term: cap.term,
      dispatcher,
      onKey: () => {},
      repaintThrottleMs: 0,
      progressIndicator: false,
      mouse: false,
    });
    const priv = screen as unknown as Record<string, unknown> & {
      drawBar(slot: string, row: number): void;
    };
    priv["started"] = true;
    screen.setBarConfig({
      composer: {
        top: { left: ["status"], right: ["cost"] },
        bottom: { left: [], right: [] },
      },
      sessionbar: { left: [], right: [] },
    });
    screen.setBtwOverlayMeta({
      sessionId: "hydra-f0f0f0f0",
      usage: { used: 8200, costAmount: 0.12 },
    });
    cap.reset();
    (priv["painter"] as { clearCache(): void }).clearCache();
    priv.drawBar("btw", 3);
    // sessionId dropped from the slot → dropped from the frame too.
    expect(cap.row(3)).not.toContain("hydra-f0f0f0f0");
    expect(cap.row(3)).toContain("By the way");
    expect(cap.row(3)).toContain("$0.12");
  });
});

// Adding one field used to mean restating the whole side — copying the
// default list (freezing it) and knowing that `elapsed` needs
// {"separator": " "} or the row reads "Busy · 1m 2s".
describe('the "..." defaults sentinel', () => {
  const ids = (side: BarSideConfig): string[] =>
    side.map((e) => (typeof e === "string" ? e : (e.field ?? `text:${e.text}`)));

  it("appends without restating the default list", () => {
    expect(ids(expandSide("composerTop", "left", ["...", "cwd"]))).toEqual([
      "status",
      "elapsed",
      "sessionId",
      "queued",
      "scroll",
      "cwd",
    ]);
  });

  it("prepends", () => {
    expect(ids(expandSide("composerTop", "left", ["cwd", "..."]))).toEqual([
      "cwd",
      "status",
      "elapsed",
      "sessionId",
      "queued",
      "scroll",
    ]);
  });

  it("repositions rather than duplicating an explicitly named field", () => {
    expect(
      ids(expandSide("composerTop", "left", ["queued", "..."])),
    ).toEqual(["queued", "status", "elapsed", "sessionId", "scroll"]);
  });

  it("matches the object entry form too", () => {
    const out = expandSide("composerTop", "left", [
      { field: "elapsed", maxWidth: 6 },
      "...",
    ]);
    expect(ids(out)).toEqual([
      "elapsed",
      "status",
      "sessionId",
      "queued",
      "scroll",
    ]);
    // The user's own entry survives with its overrides intact.
    expect(out[0]).toEqual({ field: "elapsed", maxWidth: 6 });
  });

  it("carries the default's own overrides into the expansion", () => {
    // `elapsed` must keep its " " separator or the row reads
    // "Busy · 1m 2s" instead of "Thinking 1m 2s".
    const out = expandSide("composerTop", "left", ["...", "cwd"]);
    expect(out[1]).toEqual({ field: "elapsed", separator: " " });
  });

  it("expands only the first sentinel", () => {
    expect(
      ids(expandSide("composerTop", "right", ["...", "cost", "..."])),
    ).toEqual(["usage", "cost"]);
  });

  it("is a no-op on a side that does not use it", () => {
    const side: BarSideConfig = ["cwd", "title"];
    expect(expandSide("sessionbar", "left", side)).toBe(side);
  });

  it("expands an empty default to nothing", () => {
    expect(ids(expandSide("composerBottom", "left", ["...", "mode"]))).toEqual([
      "mode",
    ]);
  });

  it("resolves on the btw frame against composer.top's defaults", () => {
    expect(ids(expandSide("btw", "left", ["..."]))).toEqual([
      "status",
      "elapsed",
      "sessionId",
      "queued",
      "scroll",
    ]);
  });

  it("renders end to end through setBarConfig", () => {
    const bar: BarLayoutConfig = {
      composer: {
        top: { left: ["...", "cwd"], right: ["..."] },
        bottom: { left: [], right: [] },
      },
      sessionbar: { left: [], right: [] },
    };
    const r = render(140, { bar });
    expect(r.top).toContain("Thinking 1m 2s · hydra-a1b2c3d4e5 · 2 queued · ~/dev");
    expect(r.top).toContain("12.4k/200.0k · $0.31");
  });
});

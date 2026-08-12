import type { Terminal } from "terminal-kit";
import { describe, expect, it } from "vitest";
import {
  ACTION_CHOICES,
  actionPromptStep,
  promptForImportAction,
  promptForLaunchOrView,
  type ActionResult,
  type KeyInput,
  type LaunchOrViewResult,
} from "./import-action-prompt.js";
import { renderTitleStrip } from "./prompt-utils.js";

describe("actionPromptStep", () => {
  it("down arrow moves selection down, clamps at last entry", () => {
    expect(actionPromptStep(0, { kind: "down" })).toEqual({
      kind: "continue",
      selected: 1,
    });
    expect(actionPromptStep(ACTION_CHOICES.length - 1, { kind: "down" })).toEqual({
      kind: "continue",
      selected: ACTION_CHOICES.length - 1,
    });
  });

  it("up arrow moves selection up, clamps at 0", () => {
    expect(actionPromptStep(1, { kind: "up" })).toEqual({
      kind: "continue",
      selected: 0,
    });
    expect(actionPromptStep(0, { kind: "up" })).toEqual({
      kind: "continue",
      selected: 0,
    });
  });

  it("n / p mirror down / up for picker parity", () => {
    expect(actionPromptStep(0, { kind: "char", ch: "n" })).toEqual({
      kind: "continue",
      selected: 1,
    });
    expect(actionPromptStep(1, { kind: "char", ch: "p" })).toEqual({
      kind: "continue",
      selected: 0,
    });
  });

  it("Enter resolves to the highlighted choice", () => {
    expect(actionPromptStep(0, { kind: "enter" })).toEqual({
      kind: "resolve",
      action: "fork-local",
    });
    expect(actionPromptStep(1, { kind: "enter" })).toEqual({
      kind: "resolve",
      action: "view",
    });
  });

  it("f / v hotkeys jump straight to the matching choice", () => {
    expect(actionPromptStep(1, { kind: "char", ch: "f" })).toEqual({
      kind: "resolve",
      action: "fork-local",
    });
    expect(actionPromptStep(0, { kind: "char", ch: "v" })).toEqual({
      kind: "resolve",
      action: "view",
    });
    expect(actionPromptStep(0, { kind: "char", ch: "V" })).toEqual({
      kind: "resolve",
      action: "view",
    });
  });

  it("back / cancel pass through unchanged", () => {
    expect(actionPromptStep(0, { kind: "back" })).toEqual({ kind: "back" });
    expect(actionPromptStep(1, { kind: "cancel" })).toEqual({ kind: "cancel" });
  });

  it("unrelated chars are inert (don't move the cursor)", () => {
    const noop: KeyInput = { kind: "char", ch: "z" };
    expect(actionPromptStep(0, noop)).toEqual({ kind: "continue", selected: 0 });
    expect(actionPromptStep(1, noop)).toEqual({ kind: "continue", selected: 1 });
  });
});

describe("renderTitleStrip", () => {
  it("returns the plain dashes when no title is given", () => {
    expect(renderTitleStrip("──────")).toEqual({ dashes: "──────" });
  });

  it("inlines a title chip at offset 2 with surrounding dashes", () => {
    const result = renderTitleStrip("──────────────────", "title");
    expect(result.title).toEqual({ offset: 2, text: " title " });
    // Chip slot is blanked so paintTopStrip can overlay the title chip
    // on top of the dim dashes.
    expect(result.dashes.length).toBe(18);
    expect(result.dashes.slice(0, 2)).toBe("──");
    expect(result.dashes.slice(2, 9)).toBe("       ");
    expect(result.dashes.slice(9)).toBe("─────────");
  });

  it("falls back to plain dashes when the box is too narrow for a chip", () => {
    expect(renderTitleStrip("──────", "long title")).toEqual({
      dashes: "──────",
    });
  });
});

// Minimal terminal double: records every painted string against the row
// it was moved to, which is all the mouse tests need to locate the
// choice rows and read back which one carries the ❯ pointer.
type Listener = (...args: unknown[]) => void;

function makeTerm(): {
  term: Terminal;
  painted: { row: number; text: string }[];
  emit: (event: string, ...args: unknown[]) => void;
} {
  const painted: { row: number; text: string }[] = [];
  const listeners = new Map<string, Set<Listener>>();
  let row = 0;
  const term = {
    width: 80,
    height: 24,
    moveTo(_x: number, y: number) {
      row = y;
      return term;
    },
    noFormat(text: string) {
      painted.push({ row, text });
      return term;
    },
    hideCursor() {
      return term;
    },
    eraseDisplayBelow() {
      return term;
    },
    grabInput() {
      return term;
    },
    on(event: string, fn: Listener) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(fn);
      return term;
    },
    off(event: string, fn: Listener) {
      listeners.get(event)?.delete(fn);
      return term;
    },
  } as unknown as Terminal;
  const emit = (event: string, ...args: unknown[]): void => {
    for (const fn of [...(listeners.get(event) ?? [])]) {
      fn(...args);
    }
  };
  return { term, painted, emit };
}

// Row of the first painted line containing `needle`, and which choice
// currently carries the ❯ pointer. Shared by both modals' mouse tests.
function readers(painted: { row: number; text: string }[]): {
  rowOf: (needle: string) => number;
  selectedLabel: (labels: string[]) => string | undefined;
} {
  return {
    rowOf: (needle) => {
      const hit = painted.find((p) => p.text.includes(needle));
      if (!hit) {
        throw new Error(`no painted row containing ${needle}`);
      }
      return hit.row;
    },
    selectedLabel: (labels) => {
      for (let i = painted.length - 1; i >= 0; i--) {
        const entry = painted[i];
        if (entry && entry.text.includes("❯")) {
          return labels.find((l) => entry.text.includes(l));
        }
      }
      return undefined;
    },
  };
}

interface Layer {
  onKey: (name: string, m: unknown, data?: { isCharacter?: boolean }) => void;
  onMouse?: (name: string, data?: { x?: number; y?: number }) => void;
  onResize: () => void;
}

function openModal(): {
  result: Promise<LaunchOrViewResult>;
  layer: Layer;
  popped: () => number;
  rowOf: (label: string) => number;
  selectedLabel: () => string | undefined;
  box: { x: number; y: number; w: number; h: number };
} {
  const { term, painted } = makeTerm();
  const read = readers(painted);
  let layer: Layer | null = null;
  let pops = 0;
  const result = promptForLaunchOrView(
    term,
    { sessionId: "hydra-session-abc123", title: "a session", cwd: "/tmp" },
    {
      push: (l) => {
        layer = l as Layer;
      },
      pop: () => {
        pops++;
      },
    },
  );
  // Box geometry mirrors drawBox for an 80x24 terminal with an
  // 11-row content area.
  const h = 13;
  const w = 66;
  return {
    result,
    layer: layer as unknown as Layer,
    popped: () => pops,
    rowOf: read.rowOf,
    selectedLabel: () => read.selectedLabel(["Launch", "View transcript"]),
    box: {
      x: Math.floor((80 - w) / 2) + 1,
      y: Math.floor((24 - h) / 2) + 1,
      w,
      h,
    },
  };
}

describe("promptForLaunchOrView mouse", () => {
  it("hover moves the highlight to the row under the cursor", async () => {
    const m = openModal();
    // Opens on "View transcript" (the non-destructive default).
    expect(m.selectedLabel()).toBe("View transcript");
    m.layer.onMouse?.("MOUSE_MOTION", { x: 20, y: m.rowOf("Launch") });
    expect(m.selectedLabel()).toBe("Launch");
    m.layer.onKey("ESCAPE", null);
    await expect(m.result).resolves.toBe("back");
  });

  it("hover on a description row selects its choice", async () => {
    const m = openModal();
    m.layer.onMouse?.("MOUSE_MOTION", {
      x: 20,
      y: m.rowOf("start a new agent session"),
    });
    expect(m.selectedLabel()).toBe("Launch");
    m.layer.onKey("ESCAPE", null);
    await expect(m.result).resolves.toBe("back");
  });

  it("click on a choice row resolves that choice", async () => {
    const m = openModal();
    const y = m.rowOf("Launch");
    m.layer.onMouse?.("MOUSE_LEFT_BUTTON_PRESSED", { x: 20, y });
    m.layer.onMouse?.("MOUSE_LEFT_BUTTON_RELEASED", { x: 20, y });
    await expect(m.result).resolves.toBe("launch");
    expect(m.popped()).toBe(1);
  });

  it("a drag (release on a different cell) is not a click", async () => {
    const m = openModal();
    m.layer.onMouse?.("MOUSE_LEFT_BUTTON_PRESSED", {
      x: 20,
      y: m.rowOf("Launch"),
    });
    m.layer.onMouse?.("MOUSE_LEFT_BUTTON_RELEASED", {
      x: 40,
      y: m.rowOf("View transcript"),
    });
    let settled = false;
    void m.result.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    m.layer.onKey("ESCAPE", null);
    await expect(m.result).resolves.toBe("back");
  });

  it("click outside the box backs out like Esc", async () => {
    const m = openModal();
    const outside = { x: 2, y: m.box.y - 2 };
    m.layer.onMouse?.("MOUSE_LEFT_BUTTON_PRESSED", outside);
    m.layer.onMouse?.("MOUSE_LEFT_BUTTON_RELEASED", outside);
    await expect(m.result).resolves.toBe("back");
  });

  it("a click inside the box but off the choices does nothing", async () => {
    const m = openModal();
    const cell = { x: m.box.x + 3, y: m.box.y + 1 };
    m.layer.onMouse?.("MOUSE_LEFT_BUTTON_PRESSED", cell);
    m.layer.onMouse?.("MOUSE_LEFT_BUTTON_RELEASED", cell);
    let settled = false;
    void m.result.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    m.layer.onKey("ESCAPE", null);
    await expect(m.result).resolves.toBe("back");
  });

  it("wheel nudges the highlight", async () => {
    const m = openModal();
    m.layer.onMouse?.("MOUSE_WHEEL_UP");
    expect(m.selectedLabel()).toBe("Launch");
    m.layer.onMouse?.("MOUSE_WHEEL_DOWN");
    expect(m.selectedLabel()).toBe("View transcript");
    m.layer.onKey("ESCAPE", null);
    await expect(m.result).resolves.toBe("back");
  });
});

// The imported-session dialog drives its mouse through runModalPrompt's
// "mouse" listener rather than a focus layer, so it's exercised through
// the terminal double's emitter.
function openImportModal(): {
  result: Promise<ActionResult>;
  mouse: (name: string, data?: { x?: number; y?: number }) => void;
  key: (name: string) => void;
  rowOf: (needle: string) => number;
  selectedLabel: () => string | undefined;
  box: { x: number; y: number; w: number; h: number };
} {
  const { term, painted, emit } = makeTerm();
  const read = readers(painted);
  const result = promptForImportAction(term, {
    sessionId: "hydra-session-abc123",
    cwd: "/tmp/elsewhere",
    importedFromMachine: "laptop",
  } as Parameters<typeof promptForImportAction>[1]);
  const labels = ACTION_CHOICES.map((c) => c.label);
  // contentHeight = 7 + 2*choices + 2 → 13 for two choices, box h = 15.
  const h = 7 + ACTION_CHOICES.length * 2 + 2 + 2;
  const w = 66;
  return {
    result,
    mouse: (name, data) => emit("mouse", name, data),
    key: (name) => emit("key", name, null, {}),
    rowOf: read.rowOf,
    selectedLabel: () => read.selectedLabel(labels),
    box: {
      x: Math.floor((80 - w) / 2) + 1,
      y: Math.floor((24 - h) / 2) + 1,
      w,
      h,
    },
  };
}

describe("promptForImportAction mouse", () => {
  it("hover moves the highlight, click commits the hovered choice", async () => {
    const m = openImportModal();
    expect(m.selectedLabel()).toBe("View transcript");
    const y = m.rowOf("Fork locally");
    m.mouse("MOUSE_MOTION", { x: 20, y });
    expect(m.selectedLabel()).toBe("Fork locally");
    m.mouse("MOUSE_LEFT_BUTTON_PRESSED", { x: 20, y });
    m.mouse("MOUSE_LEFT_BUTTON_RELEASED", { x: 20, y });
    await expect(m.result).resolves.toBe("fork-local");
  });

  it("click outside the box backs out", async () => {
    const m = openImportModal();
    const outside = { x: 2, y: m.box.y - 2 };
    m.mouse("MOUSE_LEFT_BUTTON_PRESSED", outside);
    m.mouse("MOUSE_LEFT_BUTTON_RELEASED", outside);
    await expect(m.result).resolves.toBe("back");
  });

  it("a drag across rows does not commit", async () => {
    const m = openImportModal();
    m.mouse("MOUSE_LEFT_BUTTON_PRESSED", { x: 20, y: m.rowOf("Fork locally") });
    m.mouse("MOUSE_LEFT_BUTTON_RELEASED", {
      x: 20,
      y: m.rowOf("View transcript"),
    });
    let settled = false;
    void m.result.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    m.key("ESCAPE");
    await expect(m.result).resolves.toBe("back");
  });
});

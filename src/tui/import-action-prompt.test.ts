import { describe, expect, it } from "vitest";
import {
  ACTION_CHOICES,
  actionPromptStep,
  type KeyInput,
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
      action: "run-local",
    });
    expect(actionPromptStep(1, { kind: "enter" })).toEqual({
      kind: "resolve",
      action: "view",
    });
  });

  it("r / v hotkeys jump straight to the matching choice", () => {
    expect(actionPromptStep(1, { kind: "char", ch: "r" })).toEqual({
      kind: "resolve",
      action: "run-local",
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

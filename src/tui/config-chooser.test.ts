import { describe, expect, it } from "vitest";
import type { ConfigOption } from "../core/hydra-commands.js";
import {
  buildChooserForm,
  buildConfigIndexForm,
  currentValueLabel,
  cycleConfigValue,
} from "./config-chooser.js";

const model: ConfigOption = {
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "opus[1m]",
  options: [
    { value: "default", name: "Default (recommended)" },
    { value: "opus[1m]", name: "Opus (1M context)" },
    { value: "sonnet", name: "Sonnet" },
  ],
};

// An agent that gives no display names: value doubles as the label.
const bare: ConfigOption = {
  id: "effort",
  name: "Effort",
  type: "select",
  currentValue: "high",
  options: [
    { value: "low", name: "low" },
    { value: "high", name: "high" },
  ],
};

describe("buildChooserForm", () => {
  it("dots the live value and opens the cursor on it", () => {
    const f = buildChooserForm(model);
    expect(f.title).toBe("Model (3)");
    expect(f.cursor).toBe(1);
    expect(f.rows).toEqual([
      { id: "default", kind: "choice", label: "Default (recommended)", note: "default" },
      {
        id: "opus[1m]",
        kind: "choice",
        label: "Opus (1M context)",
        note: "opus[1m]",
        current: true,
      },
      { id: "sonnet", kind: "choice", label: "Sonnet", note: "sonnet" },
    ]);
  });

  it("omits the note when the label already is the value", () => {
    expect(buildChooserForm(bare).rows).toEqual([
      { id: "low", kind: "choice", label: "low" },
      { id: "high", kind: "choice", label: "high", current: true },
    ]);
  });

  // A currentValue the option doesn't list (agent drift, or hydra injecting
  // a live value into a stale catalog) must not park the cursor at -1.
  it("falls back to the first row when the live value is not listed", () => {
    const f = buildChooserForm({ ...model, currentValue: "ghost" });
    expect(f.cursor).toBe(0);
    expect(f.rows.some((r) => "current" in r)).toBe(false);
  });
});

describe("buildConfigIndexForm", () => {
  it("lists each dimension as a cycling row showing what it is set to", () => {
    const f = buildConfigIndexForm([model, bare]);
    expect(f.title).toBe("Session config (2)");
    expect(f.rows).toEqual([
      { id: "model", kind: "select", label: "Model", value: "Opus (1M context)" },
      { id: "effort", kind: "select", label: "Effort", value: "high" },
    ]);
  });

  // Nothing is sent until the dialog closes, so the row has to show the
  // pending pick rather than what the session is still on.
  it("shows a pending pick in place of the live value", () => {
    const f = buildConfigIndexForm([model, bare], new Map([["model", "sonnet"]]));
    expect(f.rows[0]).toMatchObject({ value: "Sonnet" });
    expect(f.rows[1]).toMatchObject({ value: "high" });
  });

  it("says Enter and Esc apply, and ^C discards", () => {
    expect(buildConfigIndexForm([model]).hints.map((h) => h.action)).toEqual([
      undefined,
      undefined,
      "save",
      "commit",
      "cancel",
    ]);
  });

  it("reports an unlisted current value verbatim", () => {
    expect(currentValueLabel({ ...model, currentValue: "ghost" })).toBe("ghost");
  });
});

describe("cycleConfigValue", () => {
  it("steps and wraps in both directions", () => {
    expect(cycleConfigValue(model, "default", 1)).toBe("opus[1m]");
    expect(cycleConfigValue(model, "sonnet", 1)).toBe("default");
    expect(cycleConfigValue(model, "default", -1)).toBe("sonnet");
  });

  it("steps to the first entry from a value that is not listed", () => {
    expect(cycleConfigValue(model, "ghost", 1)).toBe("default");
  });

  it("holds still when there is nothing to cycle", () => {
    expect(cycleConfigValue({ ...model, options: [] }, "x", 1)).toBe("x");
  });
});

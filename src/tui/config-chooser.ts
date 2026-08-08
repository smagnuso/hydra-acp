// The two forms behind the config-option pickers.
//
// Model, mode, agent and whatever else the agent advertises all arrive as
// one uniform ConfigOption list, and one validated call sets any of them
// (session/set_config_option), so they get one picker in two levels:
//
//   index   the dimensions themselves, each showing what it's set to.
//           Committing a row drills into that dimension.
//   values  one dimension's settings, with the live one dotted.
//
// This is the interactive form of what `/hydra config [<id>]` has always
// done: the daemon renders the same information as text (see
// renderConfigOptionBlock), and still does for every other client. The
// difference is picking a row versus reading a list and retyping the
// value, and that the modal isn't recorded into session history the way
// the printed block is.
//
// Pure builders, kept out of app.ts so the row shapes are testable without
// standing up a session.

import type { ConfigOption } from "../core/hydra-commands.js";
import type { FormState } from "./modal-form.js";

// Model lists run long (some agents advertise dozens); give these more of
// the screen than the eight-row ^O modal needs.
const CHOOSER_MAX_ROWS = 16;

// The value a dimension is currently set to, by display name where it has
// one — the same string its own chooser marks with a dot.
export function valueLabel(opt: ConfigOption, value: string): string {
  const hit = opt.options.find((v) => v.value === value);
  return hit ? hit.name || hit.value : value;
}

export function currentValueLabel(opt: ConfigOption): string {
  return valueLabel(opt, opt.currentValue);
}

export function buildChooserForm(opt: ConfigOption): FormState {
  return {
    title: `${opt.name} (${opt.options.length})`,
    rows: opt.options.map((v) => ({
      id: v.value,
      kind: "choice" as const,
      label: v.name || v.value,
      // The raw id earns a column only when it isn't already the label.
      ...(v.name && v.name !== v.value ? { note: v.value } : {}),
      ...(v.value === opt.currentValue ? { current: true } : {}),
    })),
    // Open on the live value: it's the row the user is reasoning from, and
    // on a long list it puts the window somewhere useful.
    cursor: Math.max(
      0,
      opt.options.findIndex((v) => v.value === opt.currentValue),
    ),
    hints: [
      { label: "↑/↓ choose" },
      { label: "⏎ switch", action: "commit" },
      { label: "s save default", action: "save" },
      { label: "Esc close", action: "close" },
    ],
    maxRows: CHOOSER_MAX_ROWS,
  };
}

export function buildConfigIndexForm(
  options: ConfigOption[],
  // configId -> the value the user has cycled to but not yet applied.
  pending: ReadonlyMap<string, string> = new Map(),
): FormState {
  return {
    title: `Session config (${options.length})`,
    rows: options.map((o) => ({
      id: o.id,
      kind: "select" as const,
      label: o.name || o.id,
      value: valueLabel(o, pending.get(o.id) ?? o.currentValue),
    })),
    cursor: 0,
    // ⏎/Esc apply rather than close, and ^C discards: same contract as the
    // ^Q questions modal, which is the other multi-row form where each row
    // is a pending decision. Cycling here does NOT apply as it does in ^O,
    // because every one of these is a round trip and one of them (agent) is
    // a process swap; arrowing past three agents to reach the fourth must
    // not swap three times.
    hints: [
      { label: "↑/↓ row" },
      { label: "←/→ choose" },
      { label: "s save default", action: "save" },
      { label: "⏎/Esc apply", action: "commit" },
      { label: "^C discard", action: "cancel" },
    ],
    maxRows: CHOOSER_MAX_ROWS,
  };
}

// Step a dimension's value by one, wrapping. Returns the current value
// unchanged when the option has nothing to cycle through.
export function cycleConfigValue(
  opt: ConfigOption,
  from: string,
  delta: 1 | -1,
): string {
  if (opt.options.length === 0) {
    return from;
  }
  const at = opt.options.findIndex((v) => v.value === from);
  // An unlisted current value (agent drift) steps to the first entry rather
  // than wrapping off a -1 index.
  const next = at === -1 ? 0 : (at + delta + opt.options.length) % opt.options.length;
  return opt.options[next]!.value;
}

// One-screen layout for an ACP form with several pick-one questions: each
// question is a row showing its short header and current answer, ←/→ changes
// the answer, Enter moves down, `s` submits. The title line carries the full
// question and the description of the option under the cursor, because a
// cycling row only has room for a label. Forms with a multi-select, a text
// field or a single question keep the page-by-page ElicitationWizard.

import type { KeyEvent } from "./input.js";
import type { ElicitationField, ParsedElicitation } from "../acp/elicitation.js";
import {
  ElicitationWizard,
  type ElicitationOutcome,
} from "./elicitation-form.js";
import { LineEditor } from "./line-editor.js";
import {
  handleFormClick,
  handleFormKey,
  type FormKeyResult,
  type FormRow,
  type FormState,
} from "./modal-form.js";
import type { FormClickTarget } from "./screen.js";

export interface ElicitationFlow {
  readonly form: FormState;
  handleKey(ev: KeyEvent): ElicitationOutcome;
  handleClick(target: FormClickTarget): ElicitationOutcome;
}

type SingleField = Extract<ElicitationField, { kind: "single" }>;

type RingEntry =
  | { t: "unset" }
  | { t: "opt"; index: number }
  | { t: "other" };

export function listEligible(parsed: ParsedElicitation): boolean {
  return parsed.fields.length >= 2 && parsed.fields.every((f) => f.kind === "single");
}

export function createElicitationFlow(parsed: ParsedElicitation): ElicitationFlow {
  return listEligible(parsed) ? new ElicitationList(parsed) : new ElicitationWizard(parsed);
}

function hintsFor(withNotes: boolean): Array<{ label: string; action?: "save" | "dismiss" | "close" }> {
  return [
    { label: "←/→ change" },
    { label: "Enter next" },
    ...(withNotes ? [{ label: "n note" }] : []),
    { label: "s submit", action: "save" },
    { label: "d decline", action: "dismiss" },
    { label: "Esc cancel", action: "close" },
  ];
}

export class ElicitationList implements ElicitationFlow {
  private readonly fields: SingleField[];
  private readonly rings: RingEntry[][];
  private readonly pos: number[];
  private readonly custom: string[];
  private cursor = 0;
  private error = "";
  private other: { row: number; state: FormState } | null = null;
  private state: FormState;

  constructor(private readonly parsed: ParsedElicitation) {
    this.fields = parsed.fields as SingleField[];
    this.rings = this.fields.map((f) => {
      const ring: RingEntry[] = [{ t: "unset" }];
      f.options.forEach((_, index) => ring.push({ t: "opt", index }));
      if (f.customKey !== undefined) {
        ring.push({ t: "other" });
      }
      return ring;
    });
    this.pos = this.fields.map((f) => {
      if (f.default === undefined) {
        return 0;
      }
      const at = f.options.findIndex((o) => o.value === String(f.default));
      return at >= 0 ? at + 1 : 0;
    });
    this.custom = this.fields.map(() => "");
    this.state = this.build();
  }

  get form(): FormState {
    return this.other?.state ?? this.state;
  }

  handleKey(ev: KeyEvent): ElicitationOutcome {
    if (this.other !== null) {
      return this.applyOther(handleFormKey(this.other.state, ev));
    }
    if (ev.type === "char" && (ev.ch === "n" || ev.ch === "N")) {
      return this.fields[this.cursor]!.customKey !== undefined
        ? this.openText(this.cursor)
        : { type: "noop" };
    }
    return this.apply(handleFormKey(this.state, ev));
  }

  handleClick(target: FormClickTarget): ElicitationOutcome {
    const results =
      this.other !== null
        ? handleFormClick(this.other.state, target)
        : handleFormClick(this.state, target);
    let out: ElicitationOutcome = { type: "noop" };
    for (const r of results) {
      const next = this.other !== null ? this.applyOther(r) : this.apply(r);
      if (next.type === "done") {
        return next;
      }
      if (next.type === "update") {
        out = next;
      }
    }
    return out;
  }

  private entry(row: number): RingEntry {
    return this.rings[row]![this.pos[row]!]!;
  }

  private valueLabel(row: number): string {
    const e = this.entry(row);
    const field = this.fields[row]!;
    if (e.t === "unset") {
      return "-";
    }
    if (e.t === "opt") {
      const label = field.options[e.index]!.label;
      return this.custom[row]!.length > 0 ? `${label} (+ note: ${this.custom[row]})` : label;
    }
    return this.custom[row]!.length > 0 ? `Other: ${this.custom[row]}` : "Other...";
  }

  private title(): string {
    const field = this.fields[this.cursor]!;
    const hasDescriptions = this.fields.some((f) => f.description !== undefined);
    const lead = hasDescriptions ? "" : `${this.parsed.message} · `;
    const e = this.entry(this.cursor);
    const note = e.t === "opt" ? field.options[e.index]!.note : undefined;
    const detail = note !== undefined ? ` · ${note}` : "";
    const err = this.error ? ` · ${this.error}` : "";
    return `${lead}${field.description ?? field.title}${detail}${err}`;
  }

  private build(): FormState {
    const rows: FormRow[] = this.fields.map((f, i) => ({
      id: `f${i}`,
      kind: "select",
      label: f.title,
      value: this.valueLabel(i),
    }));
    return {
      title: this.title(),
      rows,
      cursor: this.cursor,
      hints: hintsFor(this.fields.some((f) => f.customKey !== undefined)),
    };
  }

  private refresh(): ElicitationOutcome {
    this.state = this.build();
    return { type: "update" };
  }

  private apply(result: FormKeyResult): ElicitationOutcome {
    switch (result.type) {
      case "row":
        this.cursor = result.row;
        this.error = "";
        return this.refresh();
      case "cycle": {
        const n = this.rings[result.row]!.length;
        this.cursor = result.row;
        this.pos[result.row] = (this.pos[result.row]! + result.delta + n) % n;
        this.error = "";
        return this.refresh();
      }
      case "advance":
        return this.advance(result.row);
      case "save":
        return this.submit();
      case "dismiss":
        return { type: "done", response: { action: "decline" } };
      case "close":
      case "cancel":
        return { type: "done", response: { action: "cancel" } };
      default:
        return { type: "noop" };
    }
  }

  private advance(row: number): ElicitationOutcome {
    this.cursor = row;
    if (this.entry(row).t === "other") {
      return this.openText(row);
    }
    if (row < this.fields.length - 1) {
      this.cursor = row + 1;
      this.error = "";
      return this.refresh();
    }
    return this.submit();
  }

  // Free text for a row: the answer itself when nothing is picked, otherwise
  // a note that travels beside the pick.
  private openText(row: number): ElicitationOutcome {
    const field = this.fields[row]!;
    this.cursor = row;
    const note = this.entry(row).t === "opt";
    this.other = {
      row,
      state: {
        title: `${field.description ?? field.title} · ${note ? "add a note to your pick" : "type your own answer"}`,
        rows: [
          { id: "text", kind: "text", label: note ? "note:" : "answer:", editor: new LineEditor(this.custom[row]) },
        ],
        cursor: 0,
        hints: [
          { label: "Enter submit", action: "commit" },
          { label: "Esc back", action: "close" },
        ],
      },
    };
    return { type: "update" };
  }

  private applyOther(result: FormKeyResult): ElicitationOutcome {
    const other = this.other!;
    switch (result.type) {
      case "edited":
        return { type: "update" };
      case "commit": {
        const row = other.row;
        const textRow = other.state.rows[0];
        const text = textRow?.kind === "text" ? textRow.editor.text.trim() : "";
        this.custom[row] = text;
        const ring = this.rings[row]!;
        const otherAt = ring.findIndex((r) => r.t === "other");
        if (text.length === 0 && this.entry(row).t === "other") {
          this.pos[row] = 0;
        } else if (text.length > 0 && this.entry(row).t === "unset" && otherAt >= 0) {
          this.pos[row] = otherAt;
        }
        this.other = null;
        if (row < this.fields.length - 1) {
          this.cursor = row + 1;
        }
        return this.refresh();
      }
      case "close":
        this.other = null;
        return this.refresh();
      case "cancel":
        return { type: "done", response: { action: "cancel" } };
      default:
        return { type: "noop" };
    }
  }

  private submit(): ElicitationOutcome {
    const content: Record<string, unknown> = {};
    for (let i = 0; i < this.fields.length; i++) {
      const field = this.fields[i]!;
      const e = this.entry(i);
      if (e.t === "unset" || (e.t === "other" && this.custom[i]!.length === 0)) {
        if (field.required) {
          this.cursor = i;
          this.error = "required";
          return this.refresh();
        }
        continue;
      }
      if (e.t === "other") {
        content[field.customKey!] = this.custom[i];
        continue;
      }
      if (this.custom[i]!.length > 0) {
        content[field.customKey!] = this.custom[i];
      }
      const value = field.options[e.index]!.value;
      const boolean =
        field.options.length === 2 &&
        field.options[0]!.value === "true" &&
        field.options[1]!.value === "false";
      content[field.key] = boolean ? value === "true" : value;
    }
    return { type: "done", response: { action: "accept", content } };
  }
}

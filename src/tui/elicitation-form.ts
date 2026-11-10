// ACP form elicitation (`elicitation/create`) as a step-through wizard on
// the shared form modal. One field per page: a choice list for enums and
// booleans, a toggle list for multi-selects, a text row for the rest. The
// pure logic lives here; app.ts owns the modal slot and the JSON-RPC reply.

import type { KeyEvent } from "./input.js";
import type {
  ElicitationField,
  ElicitationValue,
  ParsedElicitation,
} from "../acp/elicitation.js";
import { fieldLabel, oneLine, validateTextInput } from "../acp/elicitation.js";
import { LineEditor } from "./line-editor.js";
import {
  handleFormKey,
  handleFormClick,
  type FormKeyResult,
  type FormRow,
  type FormState,
} from "./modal-form.js";
import type { FormClickTarget } from "./screen.js";

export { parseElicitation } from "../acp/elicitation.js";
export type {
  ElicitationField,
  ElicitationValue,
  ParsedElicitation,
} from "../acp/elicitation.js";

type Json = Record<string, unknown>;

export type ElicitationOutcome =
  | { type: "update" }
  | { type: "done"; response: Json }
  | { type: "noop" };

const OTHER_LABEL = "Other (type an answer)";
const SKIP_LABEL = "Skip this question";
const DONE_LABEL = "Done";

export class ElicitationWizard {
  private index = 0;
  private answers: Record<string, ElicitationValue> = {};
  private picked = new Set<string>();
  // Set while the "Other" text page of a select field is showing.
  private customOpen = false;
  // Set while the note page of a single-select is showing: the option row
  // the note belongs to.
  private notePick: number | null = null;
  private error = "";
  private state: FormState;

  constructor(private readonly parsed: ParsedElicitation) {
    this.state = this.startPage();
  }

  get form(): FormState {
    return this.state;
  }

  handleKey(ev: KeyEvent): ElicitationOutcome {
    if (ev.type === "char" && (ev.ch === "n" || ev.ch === "N")) {
      const field = this.field;
      const row = this.state.cursor;
      if (
        !this.customOpen &&
        field.kind === "single" &&
        field.customKey !== undefined &&
        row < field.options.length
      ) {
        this.notePick = row;
        this.customOpen = true;
        this.error = "";
        this.state = this.buildPage();
        return { type: "update" };
      }
    }
    return this.apply(handleFormKey(this.state, ev));
  }

  handleClick(target: FormClickTarget): ElicitationOutcome {
    let out: ElicitationOutcome = { type: "noop" };
    for (const result of handleFormClick(this.state, target)) {
      const next = this.apply(result);
      if (next.type === "done") {
        return next;
      }
      if (next.type === "update") {
        out = next;
      }
    }
    return out;
  }

  cancelResponse(): Json {
    return { action: "cancel" };
  }

  private get field(): ElicitationField {
    return this.parsed.fields[this.index]!;
  }

  private apply(result: FormKeyResult): ElicitationOutcome {
    switch (result.type) {
      case "row":
        this.state.cursor = result.row;
        return { type: "update" };
      case "edited":
        this.error = "";
        this.state = { ...this.state, title: this.pageTitle() };
        return { type: "update" };
      case "commit":
        return this.commit(result.row);
      case "dismiss":
        return { type: "done", response: { action: "decline" } };
      case "close":
        if (this.customOpen) {
          const back = this.notePick ?? 0;
          this.customOpen = false;
          this.notePick = null;
          this.error = "";
          this.state = this.buildPage(back);
          return { type: "update" };
        }
        return { type: "done", response: { action: "cancel" } };
      case "cancel":
        return { type: "done", response: { action: "cancel" } };
      default:
        return { type: "noop" };
    }
  }

  private commit(row: number): ElicitationOutcome {
    const field = this.field;
    if (this.customOpen || field.kind === "text") {
      return this.commitText(field);
    }
    const n = field.options.length;
    const otherRow = field.customKey !== undefined ? n : -1;
    const skipRow = field.required ? -1 : n + (otherRow >= 0 ? 1 : 0);
    if (field.kind === "single") {
      if (row < n) {
        this.answers[field.key] = this.coerceSingle(field, field.options[row]!.value);
        return this.advance();
      }
      if (row === otherRow) {
        return this.openCustom();
      }
      if (row === skipRow) {
        return this.advance();
      }
      return { type: "noop" };
    }
    if (row < n) {
      const value = field.options[row]!.value;
      if (this.picked.has(value)) {
        this.picked.delete(value);
      } else {
        this.picked.add(value);
      }
      this.state = this.buildPage(row);
      return { type: "update" };
    }
    if (row === otherRow) {
      return this.openCustom();
    }
    return this.finishMulti(field);
  }

  private coerceSingle(field: ElicitationField, value: string): ElicitationValue {
    if (field.kind === "single" && field.options.length === 2 && field.options[0]!.value === "true" && field.options[1]!.value === "false") {
      return value === "true";
    }
    return value;
  }

  private finishMulti(field: ElicitationField): ElicitationOutcome {
    if (field.kind !== "multi") {
      return { type: "noop" };
    }
    const chosen = field.options.map((o) => o.value).filter((v) => this.picked.has(v));
    if (chosen.length === 0 && field.required && field.customKey === undefined) {
      this.error = "pick at least one";
      this.state = this.buildPage(field.options.length);
      return { type: "update" };
    }
    if (field.minItems !== undefined && chosen.length < field.minItems) {
      this.error = `pick at least ${field.minItems}`;
      this.state = this.buildPage(field.options.length);
      return { type: "update" };
    }
    if (field.maxItems !== undefined && chosen.length > field.maxItems) {
      this.error = `pick at most ${field.maxItems}`;
      this.state = this.buildPage(field.options.length);
      return { type: "update" };
    }
    if (chosen.length > 0) {
      this.answers[field.key] = chosen;
    }
    return this.advance();
  }

  private openCustom(): ElicitationOutcome {
    this.customOpen = true;
    this.error = "";
    this.state = this.buildPage();
    return { type: "update" };
  }

  private commitText(field: ElicitationField): ElicitationOutcome {
    const row = this.state.rows[0];
    const text = row?.kind === "text" ? row.editor.text.trim() : "";
    if (this.customOpen) {
      this.customOpen = false;
      if (field.customKey !== undefined && text.length > 0) {
        this.answers[field.customKey] = text;
      }
      if (this.notePick !== null && field.kind === "single") {
        this.answers[field.key] = this.coerceSingle(field, field.options[this.notePick]!.value);
      }
      this.notePick = null;
      if (field.kind === "multi") {
        return this.finishMulti(field);
      }
      return this.advance();
    }
    if (field.kind !== "text") {
      return { type: "noop" };
    }
    if (text.length === 0) {
      if (field.required) {
        this.error = "required";
        this.state = { ...this.state, title: this.pageTitle() };
        return { type: "update" };
      }
      return this.advance();
    }
    const checked = validateTextInput(field, text);
    if ("error" in checked) {
      return this.reject(checked.error);
    }
    this.answers[field.key] = checked.value;
    return this.advance();
  }

  private reject(message: string): ElicitationOutcome {
    this.error = message;
    this.state = { ...this.state, title: this.pageTitle() };
    return { type: "update" };
  }

  private advance(): ElicitationOutcome {
    this.error = "";
    this.customOpen = false;
    this.picked = new Set();
    this.index += 1;
    if (this.index >= this.parsed.fields.length) {
      return { type: "done", response: { action: "accept", content: this.answers } };
    }
    this.state = this.startPage();
    return { type: "update" };
  }

  // First view of a field, with its schema default pre-populated.
  private startPage(): FormState {
    const field = this.field;
    const dflt = field.default;
    if (field.kind === "multi" && Array.isArray(dflt)) {
      for (const v of dflt) {
        if (field.options.some((o) => o.value === v)) {
          this.picked.add(v as string);
        }
      }
    }
    let cursor = 0;
    if (field.kind === "single" && dflt !== undefined) {
      const at = field.options.findIndex((o) => o.value === String(dflt));
      cursor = Math.max(0, at);
    }
    return this.buildPage(cursor);
  }

  private pageTitle(): string {
    const total = this.parsed.fields.length;
    const step = total > 1 ? ` (${this.index + 1}/${total})` : "";
    const field = this.field;
    const heading =
      total > 1 || field.title !== field.key ? ` · ${fieldLabel(field)}` : "";
    const err = this.error ? ` · ${this.error}` : "";
    // The message of a multi-question form is a lead-in; say it once.
    if (total > 1 && this.index > 0) {
      return `${fieldLabel(field)}${step}${err}`;
    }
    return `${this.parsed.message}${heading}${step}${err}`;
  }

  private buildPage(cursor = 0): FormState {
    const field = this.field;
    const rows: FormRow[] = [];
    const hints: Array<{ label: string; action?: "commit" | "dismiss" | "close" }> = [
      { label: "Enter select", action: "commit" },
      ...(field.kind === "single" && field.customKey !== undefined
        ? [{ label: "n pick + note" }]
        : []),
      { label: "d skip", action: "dismiss" },
      { label: "Esc dismiss", action: "close" },
    ];
    if (this.customOpen || field.kind === "text") {
      rows.push({
        id: "text",
        kind: "text",
        label: this.customOpen ? (this.notePick !== null ? "note:" : "answer:") : "value:",
        editor: new LineEditor(
          !this.customOpen && field.kind === "text" && field.default !== undefined
            ? String(field.default)
            : "",
        ),
      });
      return {
        title: this.pageTitle(),
        rows,
        cursor: 0,
        hints: [
          { label: "Enter submit", action: "commit" },
          { label: this.customOpen ? "Esc back" : "Esc dismiss", action: "close" },
        ],
      };
    }
    field.options.forEach((o, i) => {
      rows.push({
        id: `opt${i}`,
        kind: "choice",
        label: o.label,
        ...(o.note !== undefined ? { note: o.note } : {}),
        ...(field.kind === "multi" && this.picked.has(o.value) ? { current: true } : {}),
      });
    });
    if (field.customKey !== undefined) {
      rows.push({ id: "other", kind: "choice", label: OTHER_LABEL });
    }
    if (field.kind === "multi") {
      rows.push({ id: "done", kind: "choice", label: DONE_LABEL });
    } else if (!field.required) {
      rows.push({ id: "skip", kind: "choice", label: SKIP_LABEL });
    }
    return { title: this.pageTitle(), rows, cursor, hints };
  }
}

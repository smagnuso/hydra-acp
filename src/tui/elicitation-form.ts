// ACP form elicitation (`elicitation/create`) as a step-through wizard on
// the shared form modal. One field per page: a choice list for enums and
// booleans, a toggle list for multi-selects, a text row for the rest. The
// pure logic lives here; app.ts owns the modal slot and the JSON-RPC reply.

import type { KeyEvent } from "./input.js";
import { LineEditor } from "./line-editor.js";
import {
  handleFormKey,
  handleFormClick,
  type FormKeyResult,
  type FormRow,
  type FormState,
} from "./modal-form.js";
import type { FormClickTarget } from "./screen.js";

export type ElicitationValue = string | number | boolean | string[];

interface ElicitationOption {
  value: string;
  label: string;
  note?: string;
}

interface FieldBase {
  key: string;
  title: string;
  required: boolean;
  default?: unknown;
  // claude-acp pairs a select `question_N` with a free-text `question_N_custom`.
  // It folds into the select as an "Other" row instead of a page of its own.
  customKey?: string;
}

export type ElicitationField =
  | (FieldBase & { kind: "single"; options: ElicitationOption[] })
  | (FieldBase & {
      kind: "multi";
      options: ElicitationOption[];
      minItems?: number;
      maxItems?: number;
    })
  | (FieldBase & {
      kind: "text";
      numeric?: "number" | "integer";
      minimum?: number;
      maximum?: number;
      minLength?: number;
      maxLength?: number;
      pattern?: string;
      format?: string;
    });

export interface ParsedElicitation {
  message: string;
  fields: ElicitationField[];
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function constOptions(list: unknown): ElicitationOption[] | null {
  if (!Array.isArray(list)) {
    return null;
  }
  const out: ElicitationOption[] = [];
  for (const entry of list) {
    if (typeof entry === "string") {
      out.push({ value: entry, label: entry });
      continue;
    }
    if (!isObject(entry) || typeof entry.const !== "string") {
      return null;
    }
    const note = str(entry.description);
    out.push({
      value: entry.const,
      label: str(entry.title) ?? entry.const,
      ...(note !== undefined ? { note: oneLine(note) } : {}),
    });
  }
  return out;
}

function parseProperty(
  key: string,
  prop: unknown,
  required: boolean,
): ElicitationField | null {
  if (!isObject(prop)) {
    return null;
  }
  const title = oneLine(str(prop.title) ?? str(prop.description) ?? key);
  const base = {
    key,
    title,
    required,
    ...(prop.default !== undefined ? { default: prop.default } : {}),
  };
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  const opt = <T extends object>(o: T): T => {
    for (const k of Object.keys(o) as Array<keyof T>) {
      if (o[k] === undefined) {
        delete o[k];
      }
    }
    return o;
  };
  switch (prop.type) {
    case "string": {
      const options = constOptions(prop.oneOf) ?? constOptions(prop.enum);
      if (options !== null && options.length > 0) {
        return { ...base, kind: "single", options };
      }
      return {
        ...base,
        kind: "text",
        ...opt({
          minLength: num(prop.minLength),
          maxLength: num(prop.maxLength),
          pattern: str(prop.pattern),
          format: str(prop.format),
        }),
      };
    }
    case "boolean":
      return {
        ...base,
        kind: "single",
        options: [
          { value: "true", label: "Yes" },
          { value: "false", label: "No" },
        ],
      };
    case "number":
    case "integer":
      return {
        ...base,
        kind: "text",
        numeric: prop.type,
        ...opt({ minimum: num(prop.minimum), maximum: num(prop.maximum) }),
      };
    case "array": {
      const items = isObject(prop.items) ? prop.items : {};
      const options = constOptions(items.anyOf) ?? constOptions(items.enum);
      if (options === null || options.length === 0) {
        return null;
      }
      return {
        ...base,
        kind: "multi",
        options,
        ...opt({ minItems: num(prop.minItems), maxItems: num(prop.maxItems) }),
      };
    }
    default:
      return null;
  }
}

// Null when any field is a shape this wizard cannot render. The caller then
// abstains (-32601) so a client that can render it gets the request.
export function parseElicitation(params: unknown): ParsedElicitation | null {
  if (!isObject(params) || params.mode !== "form" || !isObject(params.requestedSchema)) {
    return null;
  }
  const props = params.requestedSchema.properties;
  if (!isObject(props)) {
    return null;
  }
  const requiredList = Array.isArray(params.requestedSchema.required)
    ? (params.requestedSchema.required as unknown[])
    : [];
  const fields: ElicitationField[] = [];
  const folded = new Set<string>();
  for (const [key, prop] of Object.entries(props)) {
    if (folded.has(key)) {
      continue;
    }
    const field = parseProperty(key, prop, requiredList.includes(key));
    if (field === null) {
      return null;
    }
    const customKey = `${key}_custom`;
    const custom = props[customKey];
    if (
      field.kind !== "text" &&
      isObject(custom) &&
      custom.type === "string" &&
      custom.oneOf === undefined &&
      custom.enum === undefined
    ) {
      field.customKey = customKey;
      folded.add(customKey);
    }
    fields.push(field);
  }
  if (fields.length === 0) {
    return null;
  }
  return { message: oneLine(str(params.message) ?? "The agent has a question"), fields };
}

export type ElicitationOutcome =
  | { type: "update" }
  | { type: "done"; response: Json }
  | { type: "noop" };

const MAX_PATTERN_LENGTH = 256;
const MAX_PATTERN_INPUT = 10_000;

// Null when the text is acceptable. The pattern is an ACP extension whose
// evaluation must be bounded, so an oversized pattern or input is skipped
// rather than handed to the regex engine.
function checkString(
  field: ElicitationField & { kind: "text" },
  text: string,
): string | null {
  if (field.minLength !== undefined && text.length < field.minLength) {
    return `at least ${field.minLength} characters`;
  }
  if (field.maxLength !== undefined && text.length > field.maxLength) {
    return `at most ${field.maxLength} characters`;
  }
  if (
    field.pattern !== undefined &&
    field.pattern.length <= MAX_PATTERN_LENGTH &&
    text.length <= MAX_PATTERN_INPUT
  ) {
    try {
      if (!new RegExp(field.pattern, "u").test(text)) {
        return "does not match the expected format";
      }
    } catch {
      void 0;
    }
  }
  switch (field.format) {
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? null : "not an email address";
    case "uri":
      return URL.canParse(text) ? null : "not a URI";
    case "date":
      return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(text))
        ? null
        : "expected YYYY-MM-DD";
    case "date-time":
      return /^\d{4}-\d{2}-\d{2}T/.test(text) && !Number.isNaN(Date.parse(text))
        ? null
        : "expected an ISO 8601 date-time";
    default:
      return null;
  }
}

const OTHER_LABEL = "Other (type an answer)";
const SKIP_LABEL = "Skip this question";
const DONE_LABEL = "Done";

export class ElicitationWizard {
  private index = 0;
  private answers: Record<string, ElicitationValue> = {};
  private picked = new Set<string>();
  // Set while the "Other" text page of a select field is showing.
  private customOpen = false;
  private error = "";
  private state: FormState;

  constructor(private readonly parsed: ParsedElicitation) {
    this.state = this.startPage();
  }

  get form(): FormState {
    return this.state;
  }

  handleKey(ev: KeyEvent): ElicitationOutcome {
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
          this.customOpen = false;
          this.error = "";
          this.state = this.buildPage();
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
    if (field.numeric !== undefined) {
      const n = Number(text);
      if (!Number.isFinite(n) || (field.numeric === "integer" && !Number.isInteger(n))) {
        this.error = field.numeric === "integer" ? "not an integer" : "not a number";
        this.state = { ...this.state, title: this.pageTitle() };
        return { type: "update" };
      }
      if (field.minimum !== undefined && n < field.minimum) {
        return this.reject(`at least ${field.minimum}`);
      }
      if (field.maximum !== undefined && n > field.maximum) {
        return this.reject(`at most ${field.maximum}`);
      }
      this.answers[field.key] = n;
      return this.advance();
    }
    const problem = checkString(field, text);
    if (problem !== null) {
      return this.reject(problem);
    }
    this.answers[field.key] = text;
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
    const heading = total > 1 || field.title !== field.key ? ` · ${field.title}` : "";
    const err = this.error ? ` · ${this.error}` : "";
    return `${this.parsed.message}${heading}${step}${err}`;
  }

  private buildPage(cursor = 0): FormState {
    const field = this.field;
    const rows: FormRow[] = [];
    const hints = [
      { label: "Enter select", action: "commit" as const },
      { label: "d decline", action: "dismiss" as const },
      { label: "Esc cancel", action: "close" as const },
    ];
    if (this.customOpen || field.kind === "text") {
      rows.push({
        id: "text",
        kind: "text",
        label: this.customOpen ? "answer:" : "value:",
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
          { label: this.customOpen ? "Esc back" : "Esc cancel", action: "close" },
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

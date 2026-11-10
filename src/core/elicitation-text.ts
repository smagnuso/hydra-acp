// Plain-text renderings of a form elicitation for the transcript: the
// question as clients without form support see it, and the outcome everyone
// sees once it settles.

import {
  fieldLabel,
  oneLine,
  parseElicitation,
  validateTextInput,
  type ElicitationField,
  type ParsedElicitation,
} from "../acp/elicitation.js";

function optionLabel(field: ElicitationField, value: string): string {
  if (field.kind === "text") {
    return value;
  }
  return field.options.find((o) => o.value === value)?.label ?? value;
}

function describeField(field: ElicitationField, withTitle = true): string {
  if (field.kind === "text") {
    return fieldLabel(field);
  }
  const options = field.options.map((o) => o.label).join(" / ");
  const other = field.customKey !== undefined ? " / or type your own" : "";
  const many = field.kind === "multi" ? " (pick any)" : "";
  return withTitle ? `${fieldLabel(field)}${many}: ${options}${other}` : `${options}${other}${many}`;
}

export function formatElicitationQuestion(params: unknown): string {
  const parsed = parseElicitation(params);
  const message = oneLine(
    typeof (params as { message?: unknown } | null)?.message === "string"
      ? (params as { message: string }).message
      : "The agent has a question",
  );
  if (parsed === null) {
    return `**The agent asked:** ${message}`;
  }
  const lines = parsed.fields.map((f, i) =>
    parsed.fields.length > 1 ? `${i + 1}. ${describeField(f)}` : `Options: ${describeField(f, false)}`,
  );
  const tail = parsed.fields.length === 1 && parsed.fields[0]!.kind === "text" ? [] : lines;
  return [`**The agent asked:** ${parsed.message}`, ...tail].join("\n");
}

function describeAnswer(field: ElicitationField, content: Record<string, unknown>): string | null {
  const raw = content[field.key];
  const parts: string[] = [];
  if (Array.isArray(raw)) {
    parts.push(...raw.map((v) => optionLabel(field, String(v))));
  } else if (raw !== undefined && raw !== null && raw !== "") {
    parts.push(optionLabel(field, String(raw)));
  }
  const custom =
    field.customKey !== undefined ? content[field.customKey] : undefined;
  if (typeof custom === "string" && custom.length > 0) {
    parts.push(custom);
  }
  return parts.length > 0 ? parts.join(", ") : null;
}

export function formatElicitationOutcome(
  params: unknown,
  response: unknown,
  resolvedBy: string | undefined,
): string {
  const action = (response as { action?: unknown } | null)?.action;
  const by = resolvedBy !== undefined ? ` by ${resolvedBy}` : "";
  const parsed = parseElicitation(params);
  const message = parsed?.message ?? "the agent's question";
  if (action === "decline") {
    return `**Skipped${by}:** ${message}`;
  }
  if (action !== "accept") {
    // A cancel somebody chose says so; one nobody made (no client could
    // answer, or the turn was cancelled) reads as unanswered.
    return resolvedBy !== undefined
      ? `**Dismissed${by}:** ${message}`
      : `**Not answered:** ${message}`;
  }
  const content = ((response as { content?: unknown }).content ?? {}) as Record<
    string,
    unknown
  >;
  if (parsed === null) {
    return `**Answered${by}:** ${message}`;
  }
  const answers = parsed.fields.map((f) => {
    const text = describeAnswer(f, content) ?? "(no answer)";
    return parsed.fields.length > 1 ? `${f.title}: ${text}` : text;
  });
  if (parsed.fields.length > 1) {
    return [`**Answered${by}:** ${message}`, ...answers.map((a) => `- ${a}`)].join("\n");
  }
  return `**Answered${by}:** ${message} ${answers[0]}`;
}

function matchOption(
  field: Extract<ElicitationField, { kind: "single" | "multi" }>,
  token: string,
): string | null {
  const t = token.trim();
  if (/^\d+$/.test(t)) {
    return field.options[Number(t) - 1]?.value ?? null;
  }
  const lower = t.toLowerCase();
  const hit = field.options.find(
    (o) => o.label.toLowerCase() === lower || o.value.toLowerCase() === lower,
  );
  return hit?.value ?? null;
}

function fieldHint(field: ElicitationField): string {
  const skip = field.required ? "" : ", or `skip`";
  if (field.kind === "text") {
    return `_Reply with ${field.numeric !== undefined ? "a number" : "a value"}${skip}._`;
  }
  const how =
    field.kind === "multi"
      ? "option numbers or names, comma-separated"
      : "an option number or name";
  const other = field.customKey !== undefined ? ", or any text" : "";
  return `_Reply with ${how}${other}${skip}._`;
}

export type TextReply =
  | { type: "next"; prompt: string }
  | { type: "done"; response: { action: "accept"; content: Record<string, unknown> } }
  | { type: "retry"; message: string };

// Walks a form's questions one at a time for a client that cannot show a
// form: each typed reply answers the current question. A select takes an
// option number or name (comma-separated for a multi), or the free-text
// "Other" slot when the form has one; a text field takes a validated value;
// an optional question can be skipped.
export class TextAnswerer {
  private index = 0;
  private readonly answers: Record<string, unknown> = {};

  private constructor(private readonly parsed: ParsedElicitation) {}

  static create(params: unknown): TextAnswerer | null {
    const parsed = parseElicitation(params);
    return parsed === null ? null : new TextAnswerer(parsed);
  }

  private get field(): ElicitationField {
    return this.parsed.fields[this.index]!;
  }

  // The question this client is being asked right now.
  prompt(): string {
    const total = this.parsed.fields.length;
    const field = this.field;
    if (total === 1) {
      return `${formatElicitationQuestion({
        mode: "form",
        message: this.parsed.message,
        requestedSchema: this.schemaOf(field),
      })}\n${fieldHint(field)}`;
    }
    const head = this.index === 0 ? `**The agent asked:** ${this.parsed.message}\n` : "";
    return `${head}Question ${this.index + 1} of ${total}: ${describeField(field)}\n${fieldHint(field)}`;
  }

  private schemaOf(field: ElicitationField): unknown {
    return {
      type: "object",
      properties: {
        [field.key]: {
          type: field.kind === "multi" ? "array" : "string",
          title: field.title,
          ...(field.kind === "multi"
            ? { items: { anyOf: field.options.map((o) => ({ const: o.value, title: o.label })) } }
            : field.kind === "single"
              ? { oneOf: field.options.map((o) => ({ const: o.value, title: o.label })) }
              : {}),
        },
        ...(field.customKey !== undefined ? { [field.customKey]: { type: "string" } } : {}),
      },
    };
  }

  reply(text: string): TextReply {
    const field = this.field;
    const reply = text.trim();
    const retry = (why: string): TextReply => ({
      type: "retry",
      message: `${why}\n${fieldHint(field)}`,
    });
    if (reply.length === 0) {
      return retry("Empty reply.");
    }
    if (!field.required && /^skip$/i.test(reply)) {
      return this.advance();
    }
    if (field.kind === "text") {
      const checked = validateTextInput(field, reply);
      if ("error" in checked) {
        return retry(`Not accepted: ${checked.error}.`);
      }
      this.answers[field.key] = checked.value;
      return this.advance();
    }
    if (field.kind === "single") {
      const value = matchOption(field, reply);
      if (value !== null) {
        const boolean =
          field.options.length === 2 &&
          field.options[0]!.value === "true" &&
          field.options[1]!.value === "false";
        this.answers[field.key] = boolean ? value === "true" : value;
        return this.advance();
      }
    } else {
      const matches = reply.split(",").map((t) => matchOption(field, t));
      if (matches.every((m): m is string => m !== null)) {
        this.answers[field.key] = [...new Set(matches)];
        return this.advance();
      }
    }
    if (field.customKey !== undefined) {
      this.answers[field.customKey] = reply;
      return this.advance();
    }
    return retry("Not one of the options.");
  }

  private advance(): TextReply {
    this.index += 1;
    if (this.index >= this.parsed.fields.length) {
      return { type: "done", response: { action: "accept", content: this.answers } };
    }
    return { type: "next", prompt: this.prompt() };
  }
}

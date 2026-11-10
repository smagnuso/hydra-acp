// Plain-text renderings of a form elicitation for the transcript: the
// question as clients without form support see it, and the outcome everyone
// sees once it settles.

import {
  oneLine,
  parseElicitation,
  type ElicitationField,
} from "../acp/elicitation.js";

function optionLabel(field: ElicitationField, value: string): string {
  if (field.kind === "text") {
    return value;
  }
  return field.options.find((o) => o.value === value)?.label ?? value;
}

function describeField(field: ElicitationField): string {
  if (field.kind === "text") {
    return field.title;
  }
  const options = field.options.map((o) => o.label).join(" / ");
  const other = field.customKey !== undefined ? " / or type your own" : "";
  const many = field.kind === "multi" ? " (pick any)" : "";
  return `${field.title}${many}: ${options}${other}`;
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
    parsed.fields.length > 1 ? `${i + 1}. ${describeField(f)}` : `Options: ${describeField(f)}`,
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
    return `**Declined${by}:** ${message}`;
  }
  if (action !== "accept") {
    return `**Not answered:** ${message}`;
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

// Read a typed reply as the answer to a single select question: an option
// number or label (comma-separated for multi), else the free-text "Other"
// slot when the form has one. Null when it does not fit, so the caller treats
// the text as an ordinary prompt. Text fields and multi-question forms are
// not answerable this way.
export function answerFromText(
  params: unknown,
  text: string,
): { action: "accept"; content: Record<string, unknown> } | null {
  const parsed = parseElicitation(params);
  const reply = text.trim();
  if (parsed === null || parsed.fields.length !== 1 || reply.length === 0) {
    return null;
  }
  const field = parsed.fields[0]!;
  if (field.kind === "text") {
    return null;
  }
  if (field.kind === "single") {
    const value = matchOption(field, reply);
    if (value !== null) {
      const boolean =
        field.options.length === 2 &&
        field.options[0]!.value === "true" &&
        field.options[1]!.value === "false";
      return {
        action: "accept",
        content: { [field.key]: boolean ? value === "true" : value },
      };
    }
  } else {
    const matches = reply.split(",").map((t) => matchOption(field, t));
    if (matches.every((m): m is string => m !== null)) {
      return { action: "accept", content: { [field.key]: [...new Set(matches)] } };
    }
  }
  if (field.customKey !== undefined) {
    return { action: "accept", content: { [field.customKey]: reply } };
  }
  return null;
}

export function replyHint(params: unknown): string {
  const parsed = parseElicitation(params);
  const field = parsed?.fields.length === 1 ? parsed.fields[0]! : undefined;
  if (field === undefined || field.kind === "text") {
    return "";
  }
  const how = field.kind === "multi" ? "option numbers or names, comma-separated" : "an option number or name";
  const other = field.customKey !== undefined ? ", or any text" : "";
  return `\n_Reply with ${how}${other} to answer._`;
}

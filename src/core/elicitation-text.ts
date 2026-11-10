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

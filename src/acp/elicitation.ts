// Pure parsing of an ACP form elicitation (`elicitation/create`, form mode)
// into a flat field list. Shared by the daemon (transcript text) and the TUI
// wizard. Null from parseElicitation means a field shape we cannot render.

export type ElicitationValue = string | number | boolean | string[];

export interface ElicitationOption {
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

export function oneLine(s: string): string {
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


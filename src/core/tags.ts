export const MAX_TAGS = 16;
export const MAX_TAG_LENGTH = 40;

const TAG_PATTERN = /^[a-z0-9][a-z0-9._/-]*$/;

// Lowercases and trims; returns undefined when the result is not a valid tag.
export function normalizeTag(raw: string): string | undefined {
  const tag = raw.trim().replace(/^#/, "").toLowerCase();
  if (tag.length === 0 || tag.length > MAX_TAG_LENGTH) {
    return undefined;
  }
  return TAG_PATTERN.test(tag) ? tag : undefined;
}

export function normalizeTags(raw: readonly string[]): string[] {
  const out: string[] = [];
  for (const r of raw) {
    const tag = normalizeTag(r);
    if (tag !== undefined && !out.includes(tag)) {
      out.push(tag);
    }
  }
  return out.slice(0, MAX_TAGS);
}

export function sameTags(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((t, i) => t === y[i]);
}

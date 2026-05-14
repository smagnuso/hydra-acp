// Pure helpers for slash-command tab completion. Kept separate from app.ts
// so the behavior can be unit-tested without standing up the whole TUI.

export function longestCommonPrefix(names: string[]): string {
  if (names.length === 0) {
    return "";
  }
  let prefix = names[0] ?? "";
  for (let i = 1; i < names.length; i++) {
    const n = names[i] ?? "";
    let j = 0;
    while (j < prefix.length && j < n.length && prefix[j] === n[j]) {
      j += 1;
    }
    prefix = prefix.slice(0, j);
    if (prefix.length === 0) {
      break;
    }
  }
  return prefix;
}

// Compute the new first-line text after Tab. Returns null when Tab should
// be a no-op (no matches, or multiple matches and we're already at the
// divergence point — the user needs to type more to disambiguate).
//
// - Single match: commit the full name, with a trailing space ready for an
//   argument unless one already follows.
// - Multiple matches: extend the typed command up to the longest common
//   prefix among the candidates; don't commit any one of them.
export function computeTabCompletion(args: {
  matches: string[];
  firstLine: string;
}): string | null {
  const { matches, firstLine } = args;
  if (matches.length === 0) {
    return null;
  }
  const space = firstLine.indexOf(" ");
  const typedPrefix = space === -1 ? firstLine : firstLine.slice(0, space);
  const tail = space === -1 ? "" : firstLine.slice(space);

  if (matches.length === 1) {
    const name = matches[0] ?? "";
    const suffix = tail.startsWith(" ") ? "" : " ";
    return name + suffix + tail;
  }

  const commonPrefix = longestCommonPrefix(matches);
  if (commonPrefix.length <= typedPrefix.length) {
    return null;
  }
  return commonPrefix + tail;
}

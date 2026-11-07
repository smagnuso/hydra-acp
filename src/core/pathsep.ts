// Path separators a user may type. POSIX has one. Windows accepts both, since
// people paste C:\Users\... and type C:/Users/... interchangeably. A backslash
// is a legal filename character on POSIX, so it only counts as a separator on
// win32. Platform is read at call time so tests can stub it.

export function isPathSeparator(ch: string | undefined): boolean {
  return ch === "/" || (process.platform === "win32" && ch === "\\");
}

export function nativeSeparator(): string {
  return process.platform === "win32" ? "\\" : "/";
}

export function lastPathSeparator(s: string): number {
  if (process.platform !== "win32") {
    return s.lastIndexOf("/");
  }
  return Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
}

// The separator to append after a completed directory: whatever the user was
// already typing, falling back to the platform's own.
export function separatorFor(prefix: string): string {
  const last = prefix[prefix.length - 1];
  return isPathSeparator(last) ? (last as string) : nativeSeparator();
}

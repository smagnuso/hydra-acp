// Shared image-attachment constants and helpers. Centralised so the
// screen layer's drag-drop path detector, the clipboard reader, and the
// app's file ingestion all agree on what counts as a supported image
// and what's too big.

import path from "node:path";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const EXTENSION_TO_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export function mimeFromExtension(p: string): string | null {
  return EXTENSION_TO_MIME[path.extname(p).toLowerCase()] ?? null;
}

export function isSupportedImagePath(p: string): boolean {
  return mimeFromExtension(p) !== null;
}

// Format byte counts as "1.2MB" / "340KB" for chip labels. Round to one
// decimal so a 1.04MB image doesn't read as "1MB" (suggesting the cap
// is closer than it is) and so a 999-byte file reads as "1KB" not
// "0MB".
export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(0)}KB`;
  }
  return `${bytes}B`;
}

// Strict drag-and-drop path detector. Returns a non-empty array of
// absolute paths when the entire pasted string is one or more
// whitespace-separated tokens, each of which is an absolute path with
// a supported image extension. Returns null on anything else so the
// app falls back to inserting the paste as plain text.
//
// Handles three terminal flavors:
//   - bare paths separated by whitespace ("/a/foo.png /b/bar.jpg\n")
//   - single- or double-quoted paths ("'/a/foo bar.png'")
//   - file:// URIs ("file:///a/foo.png")
//
// Escaped spaces (backslash) are also accepted: "/a/foo\\ bar.png".
export function parseImageDropPaste(raw: string): string[] | null {
  const text = raw.trim();
  if (text.length === 0) {
    return null;
  }
  const tokens: string[] = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i] ?? "")) {
      i++;
    }
    if (i >= text.length) {
      break;
    }
    const ch = text[i];
    let token = "";
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      while (i < text.length && text[i] !== quote) {
        token += text[i];
        i++;
      }
      if (i >= text.length) {
        return null;
      }
      i++;
    } else {
      while (i < text.length && !/\s/.test(text[i] ?? "")) {
        if (text[i] === "\\" && i + 1 < text.length) {
          token += text[i + 1];
          i += 2;
        } else {
          token += text[i];
          i++;
        }
      }
    }
    let normalized = token;
    if (normalized.startsWith("file://")) {
      normalized = decodeURI(normalized.slice("file://".length));
    }
    if (!normalized.startsWith("/")) {
      return null;
    }
    if (!isSupportedImagePath(normalized)) {
      return null;
    }
    tokens.push(normalized);
  }
  return tokens.length > 0 ? tokens : null;
}

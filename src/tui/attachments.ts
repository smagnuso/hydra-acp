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

const SUPPORTED_MIMES = new Set(Object.values(EXTENSION_TO_MIME));

// Parse a base64-encoded data: URI for a supported image type.
// Returns null for unsupported mime types, the rare non-base64 form
// (`data:image/...,<urlencoded>`), or malformed input. Decoded size is
// estimated from the base64 length (4 chars → 3 bytes) and trimmed for
// the up-to-2 padding chars; exact would require a full decode, which
// we avoid until the app actually accepts the attachment.
export function parseDataUriImage(uri: string): {
  mimeType: string;
  data: string;
  sizeBytes: number;
} | null {
  const match = uri.match(/^data:(image\/[a-z0-9.+\-]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) {
    return null;
  }
  const mimeType = match[1]!.toLowerCase();
  if (!SUPPORTED_MIMES.has(mimeType)) {
    return null;
  }
  const data = match[2]!;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const sizeBytes = Math.floor((data.length * 3) / 4) - padding;
  return { mimeType, data, sizeBytes };
}

export function isSupportedDataUriImage(uri: string): boolean {
  return parseDataUriImage(uri) !== null;
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

// Strict drag-and-drop image detector. Returns a non-empty array of
// tokens when the entire pasted string is one or more whitespace-
// separated tokens, each of which is one of:
//   - absolute path to a supported image file ("/a/foo.png")
//   - single- or double-quoted absolute path ("'/a/foo bar.png'")
//   - file:// URI ("file:///a/foo.png")
//   - data:image/<png|jpeg|gif|webp>;base64,... URI (browser drag)
//
// Returns null on anything else so the app falls back to inserting
// the paste as plain text. Path tokens come back normalised (file://
// stripped, URI decoded); data: tokens come back verbatim and the
// app decodes them.
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
    if (token.startsWith("data:")) {
      if (!isSupportedDataUriImage(token)) {
        return null;
      }
      // Pass the URI through verbatim — the app decodes it. Keeping
      // the raw form here avoids parsing twice and avoids inflating
      // the array element size with already-decoded buffers.
      tokens.push(token);
      continue;
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

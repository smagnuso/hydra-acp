// General-purpose system clipboard reader. ctrl-v in the TUI dispatches
// an `attachment-request` effect that lands here; the result is either
// an image (becomes an Attachment chip) or text (gets inserted into
// the prompt buffer as if pasted). Image is tried first because most
// terminals already deliver text on Cmd+V via bracketed paste — the
// reason to provide ctrl-v at all is so an image on the clipboard
// reaches us, and falling back to text means one binding does both.
//
// Platform strategy:
//   - macOS: shell out to `osascript` with «class PNGf» (writes to
//     temp PNG); if that fails, run `pbpaste` for text. The coercion
//     converts JPEG/TIFF/PDF clipboard images to PNG transparently.
//   - Linux: detect `wl-paste` (Wayland) or `xclip` (X11). First ask
//     the tool which mimes the clipboard advertises, pick a supported
//     image type (png > jpeg > gif > webp), and only then fetch. This
//     matters because xclip, asked for `-t image/png` on a text-only
//     clipboard, exits 0 and dumps the *text* — so we must gate the
//     image fetch on an explicit advertisement to avoid base64-ing
//     plain text into a fake PNG attachment.
//   - Windows: not yet supported; returns a structured error.
//
// The spawn fn is injectable so tests can mock platform tools without
// touching the real process tree.

import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  MAX_ATTACHMENT_BYTES,
  formatSize,
  mimeFromExtension,
} from "./attachments.js";
import type { Attachment } from "./input.js";

export type ClipboardReadResult =
  | { ok: true; kind: "image"; attachment: Attachment }
  | { ok: true; kind: "text"; text: string }
  | { ok: false; reason: string };

// Minimal subset of child_process.spawn we depend on. Letting tests
// substitute a fake keeps platform branches hermetic.
export interface SpawnLike {
  (
    cmd: string,
    args: string[],
  ): {
    stdout: NodeJS.ReadableStream | null;
    stderr: NodeJS.ReadableStream | null;
    on(event: "error", cb: (err: Error) => void): void;
    on(event: "close", cb: (code: number | null) => void): void;
  };
}

export interface ClipboardEnv {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  spawn: SpawnLike;
  tmpdir: () => string;
}

const defaultEnv: ClipboardEnv = {
  platform: process.platform,
  env: process.env,
  spawn: nodeSpawn as unknown as SpawnLike,
  tmpdir: os.tmpdir,
};

export async function readClipboard(
  envIn: Partial<ClipboardEnv> = {},
): Promise<ClipboardReadResult> {
  const env: ClipboardEnv = { ...defaultEnv, ...envIn };
  if (env.platform === "darwin") {
    return readMacOS(env);
  }
  if (env.platform === "linux") {
    return readLinux(env);
  }
  return {
    ok: false,
    reason: `clipboard paste is not supported on ${env.platform}`,
  };
}

async function readMacOS(env: ClipboardEnv): Promise<ClipboardReadResult> {
  // Image-first: write «class PNGf» to a tmp file, read it back. If
  // the clipboard has no PNG, osascript exits non-zero — fall through
  // to text. Caller code paths that rely on the file existing must
  // not run when this branch fails, so we delete on both success and
  // failure.
  const tmpPath = path.join(
    env.tmpdir(),
    `hydra-clipboard-${Date.now()}-${process.pid}.png`,
  );
  const script = [
    "set png_data to the clipboard as «class PNGf»",
    `set out_file to (open for access (POSIX file "${tmpPath}") with write permission)`,
    "write png_data to out_file",
    "close access out_file",
  ];
  const args: string[] = [];
  for (const line of script) {
    args.push("-e", line);
  }
  try {
    await run(env.spawn, "osascript", args);
    const img = await readFileAsAttachment(tmpPath, true);
    if (img.ok) {
      return img;
    }
    // File was empty / oversized — explicit oversized error wins so
    // the user sees the cap. Otherwise fall through to text.
    if (img.reason.startsWith("clipboard image is")) {
      return img;
    }
  } catch {
    await fs.unlink(tmpPath).catch(() => undefined);
  }
  // Text fallback via pbpaste.
  try {
    const buf = await runCapture(env.spawn, "pbpaste", []);
    if (buf.length === 0) {
      return { ok: false, reason: "clipboard is empty" };
    }
    return { ok: true, kind: "text", text: normalizeText(buf.toString("utf-8")) };
  } catch {
    return { ok: false, reason: "clipboard read failed" };
  }
}

async function readLinux(env: ClipboardEnv): Promise<ClipboardReadResult> {
  const tool = await detectLinuxTool(env);
  if (!tool) {
    return {
      ok: false,
      reason:
        "install wl-clipboard (Wayland) or xclip (X11) to paste from the clipboard",
    };
  }
  const targets = await listTargets(env, tool);
  const imageMime = pickImageTarget(targets);
  if (imageMime) {
    try {
      const buf = await runCapture(
        env.spawn,
        tool.cmd,
        tool.imageArgs(imageMime),
      );
      if (buf.length > 0) {
        if (buf.length > MAX_ATTACHMENT_BYTES) {
          return {
            ok: false,
            reason: `clipboard image is ${formatSize(buf.length)}, max ${formatSize(MAX_ATTACHMENT_BYTES)}`,
          };
        }
        return {
          ok: true,
          kind: "image",
          attachment: {
            mimeType: imageMime,
            data: buf.toString("base64"),
            sizeBytes: buf.length,
          },
        };
      }
    } catch {
      // Listed but fetch failed — fall through to text.
    }
  }
  try {
    const buf = await runCapture(env.spawn, tool.cmd, tool.textArgs);
    if (buf.length === 0) {
      return { ok: false, reason: "clipboard is empty" };
    }
    return {
      ok: true,
      kind: "text",
      text: normalizeText(buf.toString("utf-8")),
    };
  } catch {
    return { ok: false, reason: "clipboard read failed" };
  }
}

interface LinuxTool {
  cmd: string;
  listTargetsArgs: string[];
  imageArgs: (mime: string) => string[];
  textArgs: string[];
}

async function detectLinuxTool(env: ClipboardEnv): Promise<LinuxTool | null> {
  if (env.env.WAYLAND_DISPLAY && (await which(env, "wl-paste"))) {
    return {
      cmd: "wl-paste",
      listTargetsArgs: ["--list-types"],
      imageArgs: (mime) => ["-t", mime],
      // -n: drop trailing newline wl-paste adds by default. We further
      // normalize line endings below, but this avoids a spurious
      // empty trailing row from a single-line clipboard text.
      textArgs: ["-n"],
    };
  }
  if (env.env.DISPLAY && (await which(env, "xclip"))) {
    return {
      cmd: "xclip",
      listTargetsArgs: ["-selection", "clipboard", "-t", "TARGETS", "-o"],
      imageArgs: (mime) => ["-selection", "clipboard", "-t", mime, "-o"],
      textArgs: ["-selection", "clipboard", "-o"],
    };
  }
  return null;
}

// Preference order matters: PNG is lossless and the format every agent
// definitely accepts, so we'd rather take it when the source offered
// multiple representations. JPEG/GIF/WEBP only come through when PNG
// isn't on offer.
const SUPPORTED_IMAGE_MIMES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

function pickImageTarget(targets: string[]): string | null {
  const offered = new Set(targets.map((t) => t.toLowerCase()));
  for (const mime of SUPPORTED_IMAGE_MIMES) {
    if (offered.has(mime)) {
      return mime;
    }
  }
  return null;
}

async function listTargets(
  env: ClipboardEnv,
  tool: LinuxTool,
): Promise<string[]> {
  try {
    const buf = await runCapture(env.spawn, tool.cmd, tool.listTargetsArgs);
    return buf
      .toString("utf-8")
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

// Match the bracketed-paste handler in screen.ts: collapse \r\n / \r
// to \n so a Windows-origin clipboard text doesn't insert literal
// carriage returns into the prompt buffer.
function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

async function which(env: ClipboardEnv, cmd: string): Promise<boolean> {
  try {
    await run(env.spawn, "which", [cmd]);
    return true;
  } catch {
    return false;
  }
}

async function readFileAsAttachment(
  p: string,
  unlinkAfter: boolean,
): Promise<ClipboardReadResult> {
  try {
    const buf = await fs.readFile(p);
    if (unlinkAfter) {
      await fs.unlink(p).catch(() => undefined);
    }
    if (buf.length === 0) {
      return { ok: false, reason: "no image on clipboard" };
    }
    if (buf.length > MAX_ATTACHMENT_BYTES) {
      return {
        ok: false,
        reason: `clipboard image is ${formatSize(buf.length)}, max ${formatSize(MAX_ATTACHMENT_BYTES)}`,
      };
    }
    const mimeType = mimeFromExtension(p) ?? "image/png";
    return {
      ok: true,
      kind: "image",
      attachment: {
        mimeType,
        data: buf.toString("base64"),
        sizeBytes: buf.length,
      },
    };
  } catch {
    return { ok: false, reason: "failed to read clipboard image" };
  }
}

// Spawn-and-await with stdout discarded. Used for fire-and-forget
// (osascript writing to temp file) and `which` probes.
function run(spawn: SpawnLike, cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    proc.stdout?.on("data", () => undefined);
    proc.stderr?.on("data", () => undefined);
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${cmd} exited ${code}`));
      }
    });
  });
}

// Spawn-and-await with stdout captured as a Buffer. Used for the
// Linux tools that emit image bytes to stdout. Resolves only after
// both the process close event AND the stdout end event have fired
// — without that, a fast-closing process can race ahead of the
// stdout drain and lose trailing bytes.
function runCapture(
  spawn: SpawnLike,
  cmd: string,
  args: string[],
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    const chunks: Buffer[] = [];
    let stdoutEnded = proc.stdout === null;
    let closedCode: number | null = null;
    let settled = false;

    const settle = () => {
      if (settled || !stdoutEnded || closedCode === null) {
        return;
      }
      settled = true;
      if (closedCode === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`${cmd} exited ${closedCode}`));
      }
    };

    proc.stdout?.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    proc.stdout?.on("end", () => {
      stdoutEnded = true;
      settle();
    });
    proc.stderr?.on("data", () => undefined);
    proc.on("error", (err) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(err);
    });
    proc.on("close", (code) => {
      closedCode = code ?? 0;
      settle();
    });
  });
}

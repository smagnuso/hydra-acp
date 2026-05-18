import { EventEmitter, Readable } from "node:stream";
import fs from "node:fs/promises";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readClipboard, type SpawnLike } from "./clipboard.js";

// A spawn fake that walks through a queue of pre-staged outcomes. Each
// outcome models a single child process: stdout bytes, optional stderr,
// and an exit code. Tests push outcomes in the order calls will happen.
interface SpawnOutcome {
  cmd: string;
  args: string[];
  stdout?: Buffer;
  code: number;
  // If set, the file at this path is written before exit. Used to
  // simulate osascript dropping a PNG into the temp file we passed it.
  writeFile?: { path: string; bytes: Buffer };
}

function makeSpawnFake(outcomes: SpawnOutcome[]): {
  spawn: SpawnLike;
  calls: Array<{ cmd: string; args: string[] }>;
} {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  let i = 0;
  const spawn: SpawnLike = (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const outcome = outcomes[i++];
    if (!outcome) {
      throw new Error(`unexpected spawn(${cmd} ${args.join(" ")})`);
    }
    if (outcome.cmd !== cmd) {
      throw new Error(`expected spawn(${outcome.cmd}) got ${cmd}`);
    }
    const emitter = new EventEmitter();
    const stdout = Readable.from([outcome.stdout ?? Buffer.alloc(0)]);
    const stderr = Readable.from([Buffer.alloc(0)]);
    const proc = emitter as unknown as ReturnType<SpawnLike> & EventEmitter;
    (proc as unknown as { stdout: Readable }).stdout = stdout;
    (proc as unknown as { stderr: Readable }).stderr = stderr;
    queueMicrotask(async () => {
      if (outcome.writeFile) {
        await fs.writeFile(outcome.writeFile.path, outcome.writeFile.bytes);
      }
      emitter.emit("close", outcome.code);
    });
    return proc;
  };
  return { spawn, calls };
}

const tmpRoots: string[] = [];
async function freshTmpdir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-clipboard-test-"));
  tmpRoots.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tmpRoots.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

// Wrap a fake spawn so we can capture the temp path osascript was told
// to write to, and stage a PNG into that path before close fires.
function withOsascriptCapture(
  inner: SpawnLike,
  png: Buffer | null,
): SpawnLike {
  return (cmd, args) => {
    // Write the file synchronously before inner() queues the close
    // microtask — otherwise close fires before the async write lands.
    if (png) {
      for (const a of args) {
        const m = a.match(/POSIX file "([^"]+)"/);
        if (m?.[1]) {
          writeFileSync(m[1], png);
          break;
        }
      }
    }
    return inner(cmd, args);
  };
}

describe("readClipboard — macOS", () => {
  it("returns an image when osascript writes a PNG", async () => {
    const tmp = await freshTmpdir();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { spawn } = makeSpawnFake([
      { cmd: "osascript", args: [], code: 0 },
    ]);
    const wrapped = withOsascriptCapture(spawn, png);
    const result = await readClipboard({
      platform: "darwin",
      env: {},
      spawn: wrapped,
      tmpdir: () => tmp,
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === "image") {
      expect(result.attachment.mimeType).toBe("image/png");
      expect(result.attachment.sizeBytes).toBe(png.length);
      expect(Buffer.from(result.attachment.data, "base64")).toEqual(png);
    } else {
      throw new Error("expected image result");
    }
  });

  it("falls back to pbpaste when osascript exits non-zero", async () => {
    const tmp = await freshTmpdir();
    const text = Buffer.from("clipboard text content");
    const { spawn, calls } = makeSpawnFake([
      { cmd: "osascript", args: [], code: 1 },
      { cmd: "pbpaste", args: [], code: 0, stdout: text },
    ]);
    const result = await readClipboard({
      platform: "darwin",
      env: {},
      spawn,
      tmpdir: () => tmp,
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === "text") {
      expect(result.text).toBe("clipboard text content");
    } else {
      throw new Error("expected text result");
    }
    expect(calls.map((c) => c.cmd)).toEqual(["osascript", "pbpaste"]);
  });

  it("normalizes Windows line endings in pasted text", async () => {
    const tmp = await freshTmpdir();
    const text = Buffer.from("line1\r\nline2\rline3");
    const { spawn } = makeSpawnFake([
      { cmd: "osascript", args: [], code: 1 },
      { cmd: "pbpaste", args: [], code: 0, stdout: text },
    ]);
    const result = await readClipboard({
      platform: "darwin",
      env: {},
      spawn,
      tmpdir: () => tmp,
    });
    expect(result.ok && result.kind === "text" && result.text).toBe(
      "line1\nline2\nline3",
    );
  });

  it("returns clipboard-empty when neither image nor text is available", async () => {
    const tmp = await freshTmpdir();
    const { spawn } = makeSpawnFake([
      { cmd: "osascript", args: [], code: 1 },
      { cmd: "pbpaste", args: [], code: 0, stdout: Buffer.alloc(0) },
    ]);
    const result = await readClipboard({
      platform: "darwin",
      env: {},
      spawn,
      tmpdir: () => tmp,
    });
    expect(result).toEqual({ ok: false, reason: "clipboard is empty" });
  });
});

describe("readClipboard — Linux", () => {
  it("returns an image when wl-paste delivers PNG bytes", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const { spawn, calls } = makeSpawnFake([
      { cmd: "which", args: ["wl-paste"], code: 0 },
      { cmd: "wl-paste", args: ["-t", "image/png"], code: 0, stdout: png },
    ]);
    const result = await readClipboard({
      platform: "linux",
      env: { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
      spawn,
      tmpdir: () => "/tmp",
    });
    expect(result.ok && result.kind).toBe("image");
    if (result.ok && result.kind === "image") {
      expect(Buffer.from(result.attachment.data, "base64")).toEqual(png);
    }
    expect(calls.map((c) => c.cmd)).toEqual(["which", "wl-paste"]);
  });

  it("falls back to text on wl-paste when the image target is empty", async () => {
    const text = Buffer.from("hello\nworld");
    const { spawn, calls } = makeSpawnFake([
      { cmd: "which", args: ["wl-paste"], code: 0 },
      {
        cmd: "wl-paste",
        args: ["-t", "image/png"],
        code: 0,
        stdout: Buffer.alloc(0),
      },
      { cmd: "wl-paste", args: ["-n"], code: 0, stdout: text },
    ]);
    const result = await readClipboard({
      platform: "linux",
      env: { WAYLAND_DISPLAY: "wayland-0" },
      spawn,
      tmpdir: () => "/tmp",
    });
    expect(result.ok && result.kind === "text" && result.text).toBe(
      "hello\nworld",
    );
    expect(calls.map((c) => c.args.join(" "))).toEqual([
      "wl-paste",
      "-t image/png",
      "-n",
    ]);
  });

  it("falls back to text on wl-paste when the image target errors", async () => {
    const text = Buffer.from("text-only clipboard");
    const { spawn } = makeSpawnFake([
      { cmd: "which", args: ["wl-paste"], code: 0 },
      { cmd: "wl-paste", args: ["-t", "image/png"], code: 1 },
      { cmd: "wl-paste", args: ["-n"], code: 0, stdout: text },
    ]);
    const result = await readClipboard({
      platform: "linux",
      env: { WAYLAND_DISPLAY: "wayland-0" },
      spawn,
      tmpdir: () => "/tmp",
    });
    expect(result.ok && result.kind === "text" && result.text).toBe(
      "text-only clipboard",
    );
  });

  it("uses xclip when DISPLAY is set but Wayland is not", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const { spawn, calls } = makeSpawnFake([
      { cmd: "which", args: ["xclip"], code: 0 },
      {
        cmd: "xclip",
        args: ["-selection", "clipboard", "-t", "image/png", "-o"],
        code: 0,
        stdout: png,
      },
    ]);
    const result = await readClipboard({
      platform: "linux",
      env: { DISPLAY: ":0" },
      spawn,
      tmpdir: () => "/tmp",
    });
    expect(result.ok && result.kind).toBe("image");
    expect(calls.map((c) => c.cmd)).toEqual(["which", "xclip"]);
  });

  it("returns install hint when neither tool is available", async () => {
    const { spawn } = makeSpawnFake([]);
    const result = await readClipboard({
      platform: "linux",
      env: {},
      spawn,
      tmpdir: () => "/tmp",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/wl-clipboard.*xclip/);
    }
  });

  it("returns clipboard-empty when both image and text are empty", async () => {
    const { spawn } = makeSpawnFake([
      { cmd: "which", args: ["wl-paste"], code: 0 },
      {
        cmd: "wl-paste",
        args: ["-t", "image/png"],
        code: 0,
        stdout: Buffer.alloc(0),
      },
      { cmd: "wl-paste", args: ["-n"], code: 0, stdout: Buffer.alloc(0) },
    ]);
    const result = await readClipboard({
      platform: "linux",
      env: { WAYLAND_DISPLAY: "wayland-0" },
      spawn,
      tmpdir: () => "/tmp",
    });
    expect(result).toEqual({ ok: false, reason: "clipboard is empty" });
  });
});

describe("readClipboard — unsupported platforms", () => {
  it("returns a structured error on Windows (not yet supported)", async () => {
    const { spawn } = makeSpawnFake([]);
    const result = await readClipboard({
      platform: "win32",
      env: {},
      spawn,
      tmpdir: () => "/tmp",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/win32/);
    }
  });
});

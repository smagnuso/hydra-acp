import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "terminal-kit";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

import { onPlatform, pinPlatform } from "../core/platform-stub.js";
import type { InputDispatcher } from "./input.js";
import { Screen } from "./screen.js";

// These suites assert POSIX behaviour; Windows-specific cases stub win32 themselves.
pinPlatform("linux");

function makeScreen(openFileCommand: string | readonly string[]): Screen {
  const handler: ProxyHandler<(...args: unknown[]) => unknown> = {
    apply: () => term,
    get(_target, prop) {
      if (prop === "width") return 120;
      if (prop === "height") return 24;
      if (prop === "on" || prop === "off") return () => undefined;
      return new Proxy(() => term, handler);
    },
  };
  const term = new Proxy(
    function noop() {} as (...args: unknown[]) => unknown,
    handler,
  ) as unknown as Terminal;
  const dispatcher = {
    state: () => ({
      buffer: [""],
      row: 0,
      col: 0,
      planMode: false,
      historyIndex: -1,
      queueIndex: -1,
      attachments: [],
      historySearchQuery: null,
    }),
  } as unknown as InputDispatcher;
  return new Screen({
    term,
    dispatcher,
    onKey: () => {},
    repaintThrottleMs: 0,
    progressIndicator: false,
    mouse: true,
    openFileCommand,
    openFileSource: "config",
    openFileInTerminal: false,
  });
}

function openWith(screen: Screen, file: string): boolean {
  screen.setSessionbar({ cwd: tmpdir() });
  return (
    screen as unknown as { tryOpenPathString: (raw: string) => boolean }
  ).tryOpenPathString(file);
}

describe("detached open-file launch", () => {
  let root: string;
  let file: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockReturnValue({ on: () => undefined, unref: () => undefined });
    root = mkdtempSync(join(tmpdir(), "hydra-open-ed-"));
    file = join(root, "notes.md");
    writeFileSync(file, "x\n");
    savedPath = process.env["PATH"];
  });

  afterEach(() => {
    process.env["PATH"] = savedPath;
  });

  function shimDir(name: string): string {
    const dir = join(root, name);
    mkdirSync(dir);
    writeFileSync(join(dir, "myeditor.cmd"), "@echo off\n");
    return dir;
  }

  it("runs a .cmd editor shim through the shell on Windows and hides its console", async () => {
    process.env["PATH"] = shimDir("bin");
    await onPlatform("win32", () => {
      expect(openWith(makeScreen(["myeditor"]), file)).toBe(true);
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnMock.mock.calls[0]!;
    expect(String(command)).toMatch(/myeditor\.cmd$/i);
    expect(args).toEqual([file]);
    expect(options).toMatchObject({
      detached: true,
      stdio: "ignore",
      shell: true,
      windowsHide: true,
    });
  });

  it("quotes a shim path and a file path that contain spaces", async () => {
    process.env["PATH"] = shimDir("my bin");
    const spaced = join(root, "my notes.md");
    writeFileSync(spaced, "x\n");
    await onPlatform("win32", () => {
      expect(openWith(makeScreen(["myeditor"]), spaced)).toBe(true);
    });
    const [command, args] = spawnMock.mock.calls[0]!;
    expect(String(command).startsWith('"')).toBe(true);
    expect(args).toEqual([`"${spaced}"`]);
  });

  it("launches an ordinary program directly and does not hide a GUI window", async () => {
    process.env["PATH"] = root;
    await onPlatform("win32", () => {
      expect(openWith(makeScreen(["notepad"]), file)).toBe(true);
    });
    const [command, , options] = spawnMock.mock.calls[0]!;
    expect(command).toBe("notepad");
    expect(options).not.toHaveProperty("shell");
    expect(options).not.toHaveProperty("windowsHide");
  });

  it("is unchanged off Windows", () => {
    openWith(makeScreen(["vim"]), file);
    const [command, args, options] = spawnMock.mock.calls[0]!;
    expect(command).toBe("vim");
    expect(args).toEqual([file]);
    expect(options).toEqual({
      detached: true,
      stdio: "ignore",
      cwd: expect.any(String),
    });
  });

  it("keeps a quoted editor path with spaces as one program when given as a string", () => {
    openWith(makeScreen('"/opt/my editor/vim" -f'), file);
    const [command, args] = spawnMock.mock.calls[0]!;
    expect(command).toBe("/opt/my editor/vim");
    expect(args).toEqual(["-f", file]);
  });
});

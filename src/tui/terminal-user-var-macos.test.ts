import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const spawnSyncMock = vi.hoisted(() => vi.fn());
const readlinkMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (orig) => ({
  ...(await orig<typeof import("node:child_process")>()),
  spawnSync: spawnSyncMock,
}));
vi.mock("node:fs", async (orig) => {
  const real = await orig<typeof import("node:fs")>();
  return {
    ...real,
    readlinkSync: readlinkMock,
    default: { ...real, readlinkSync: readlinkMock },
  };
});

import {
  __resetTtyCacheForTests,
  publishActiveHydraSession,
} from "./terminal-user-var.js";

// Simulates macOS: both readlink strategies fail with EINVAL, and tty(1)
// only answers when it inherits the real terminal as stdin.
describe("resolveTtyBasename without /proc (macOS)", () => {
  const originalHome = process.env.HYDRA_ACP_HOME;
  const originalIsTTY = (process.stdin as { isTTY?: boolean }).isTTY;
  const originalWrite = process.stdout.write.bind(process.stdout);
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hydra-tty-mac-"));
    process.env.HYDRA_ACP_HOME = tmpHome;
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    readlinkMock.mockImplementation(() => {
      throw Object.assign(new Error("EINVAL"), { code: "EINVAL" });
    });
    spawnSyncMock.mockImplementation(
      (_cmd: string, _args: string[], opts: { stdio?: unknown[] }) =>
        opts.stdio?.[0] === "inherit"
          ? { status: 0, stdout: "/dev/ttys004\n" }
          : { status: 1, stdout: "not a tty\n" },
    );
    __resetTtyCacheForTests();
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
    (process.stdin as { isTTY?: boolean }).isTTY = originalIsTTY;
    if (originalHome === undefined) {
      delete process.env.HYDRA_ACP_HOME;
    } else {
      process.env.HYDRA_ACP_HOME = originalHome;
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
    vi.clearAllMocks();
    __resetTtyCacheForTests();
  });

  it("writes the sticky file using tty(1) with inherited stdin", () => {
    publishActiveHydraSession("hydra_session_mac");
    const file = path.join(tmpHome, "tty", "ttys004");
    expect(fs.readFileSync(file, "utf8")).toBe(
      `${process.pid}:${process.ppid}:hydra_session_mac\n`,
    );
  });
});

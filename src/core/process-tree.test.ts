import { afterEach, describe, expect, it, vi } from "vitest";
import { terminateChild, terminatePid } from "./process-tree.js";

function fakeChild(pid: number | undefined) {
  return { pid, kill: vi.fn(() => true) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("terminateChild", () => {
  it("ends the whole tree by pid on Windows and never calls child.kill", () => {
    const child = fakeChild(4242);
    const killTree = vi.fn();
    terminateChild(child, "SIGTERM", { platform: "win32", killTree });
    expect(killTree).toHaveBeenCalledWith(4242);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("falls back to child.kill when the tree kill throws", () => {
    const child = fakeChild(4242);
    const killTree = vi.fn(() => {
      throw new Error("taskkill missing");
    });
    terminateChild(child, "SIGKILL", { platform: "win32", killTree });
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("uses child.kill when there is no pid", () => {
    const child = fakeChild(undefined);
    const killTree = vi.fn();
    terminateChild(child, "SIGTERM", { platform: "win32", killTree });
    expect(killTree).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("is a plain child.kill with the same signal off Windows", () => {
    for (const platform of ["linux", "darwin"] as const) {
      const child = fakeChild(4242);
      const killTree = vi.fn();
      terminateChild(child, "SIGTERM", { platform, killTree });
      expect(killTree).not.toHaveBeenCalled();
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    }
  });
});

describe("terminatePid", () => {
  it("ends the tree by pid on Windows", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const killTree = vi.fn();
    terminatePid(4242, "SIGTERM", { platform: "win32", killTree });
    expect(killTree).toHaveBeenCalledWith(4242);
    expect(kill).not.toHaveBeenCalled();
  });

  it("falls back to process.kill when the tree kill throws", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const killTree = vi.fn(() => {
      throw new Error("taskkill missing");
    });
    terminatePid(4242, "SIGKILL", { platform: "win32", killTree });
    expect(kill).toHaveBeenCalledWith(4242, "SIGKILL");
  });

  it("is a plain process.kill with the same signal off Windows", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const killTree = vi.fn();
    terminatePid(4242, "SIGTERM", { platform: "linux", killTree });
    expect(killTree).not.toHaveBeenCalled();
    expect(kill).toHaveBeenCalledWith(4242, "SIGTERM");
  });
});

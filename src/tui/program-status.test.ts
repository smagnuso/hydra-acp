import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearProgramStatus,
  encodeProgramStatus,
  publishProgramStatus,
} from "./program-status.js";

describe("encodeProgramStatus", () => {
  it("maps activity onto protocol states", () => {
    expect(encodeProgramStatus("working")).toBe("\x1b]7501;state=working:app=hydra\x1b\\");
    expect(encodeProgramStatus("idle")).toBe("\x1b]7501;state=idle:app=hydra\x1b\\");
    expect(encodeProgramStatus("unknown")).toBe("\x1b]7501;state=clear:app=hydra\x1b\\");
  });

  it("tags a permission block with its kind and a base64 message", () => {
    const msg = Buffer.from("Permission requested").toString("base64");
    expect(encodeProgramStatus("blocked")).toBe(
      `\x1b]7501;state=blocked:kind=permission:app=hydra:msg=${msg}\x1b\\`,
    );
  });
});

describe("publishProgramStatus", () => {
  const origTty = process.stdout.isTTY;

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    process.stdout.isTTY = origTty;
    clearProgramStatus();
  });

  function capture(): string[] {
    const out: string[] = [];
    process.stdout.isTTY = true;
    vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      out.push(String(s));
      return true;
    });
    return out;
  }

  it("is on by default", () => {
    vi.stubEnv("TMUX", "");
    const out = capture();
    publishProgramStatus("working");
    expect(out).toHaveLength(1);
  });

  it("writes nothing when disabled", () => {
    vi.stubEnv("HYDRA_OSC7501", "0");
    const out = capture();
    publishProgramStatus("working");
    expect(out).toEqual([]);
  });

  it("dedupes repeated states", () => {
    vi.stubEnv("TMUX", "");
    const out = capture();
    publishProgramStatus("working");
    publishProgramStatus("working");
    publishProgramStatus("idle");
    expect(out).toHaveLength(2);
  });

  it("wraps for tmux passthrough with doubled escapes", () => {
    vi.stubEnv("TMUX", "/tmp/tmux-1000/default,1,0");
    const out = capture();
    publishProgramStatus("idle");
    expect(out[0]).toBe("\x1bPtmux;\x1b\x1b]7501;state=idle:app=hydra\x1b\x1b\\\x1b\\");
  });
});

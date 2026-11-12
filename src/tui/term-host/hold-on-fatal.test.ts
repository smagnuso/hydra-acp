import { describe, expect, it, vi } from "vitest";
import {
  HOLD_ON_FATAL_ENV,
  holdOnFatal,
  holdOnFatalEnv,
  shouldHoldOnFatal,
  type HoldInput,
} from "./hold-on-fatal.js";

describe("shouldHoldOnFatal", () => {
  const tty = { isTTY: true };

  it("holds only when marked and attached to a terminal", () => {
    expect(shouldHoldOnFatal(holdOnFatalEnv(), tty, tty)).toBe(true);
    expect(shouldHoldOnFatal({}, tty, tty)).toBe(false);
    expect(shouldHoldOnFatal({ [HOLD_ON_FATAL_ENV]: "0" }, tty, tty)).toBe(false);
  });

  it("never waits on a keypress nobody can send", () => {
    expect(shouldHoldOnFatal(holdOnFatalEnv(), {}, tty)).toBe(false);
    expect(shouldHoldOnFatal(holdOnFatalEnv(), tty, {})).toBe(false);
  });
});

describe("holdOnFatal", () => {
  it("prompts, then returns on the first key and restores the terminal", async () => {
    let fire: () => void = () => {};
    const modes: boolean[] = [];
    const stdin: HoldInput = {
      setRawMode: (m) => modes.push(m),
      once: (_e, l) => {
        fire = l;
      },
      resume: vi.fn(),
      pause: vi.fn(),
    };
    const out: string[] = [];
    const done = holdOnFatal(stdin, (t) => out.push(t));
    expect(out.join("")).toContain("Press any key");
    expect(modes).toEqual([true]);
    fire();
    await done;
    expect(modes).toEqual([true, false]);
    expect(stdin.pause).toHaveBeenCalled();
  });
});

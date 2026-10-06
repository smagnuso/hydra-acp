import { describe, expect, it } from "vitest";
import { paneInView } from "./pane-in-view.js";
import type { TerminalHost } from "./term-host/types.js";

function host(focus: boolean, isFocused?: () => Promise<boolean | null>): TerminalHost {
  return {
    id: "fake",
    caps: { openTab: false, split: false, label: false, report: false, reveal: false, focus },
    report: async () => undefined,
    release: async () => undefined,
    ...(isFocused ? { isFocused } : {}),
  };
}

describe("paneInView", () => {
  it("is out of view when the terminal reports it lost focus, without asking the host", async () => {
    let asked = false;
    const h = host(true, async () => {
      asked = true;
      return true;
    });
    expect(await paneInView({ terminalFocused: false, host: h })).toBe(false);
    expect(asked).toBe(false);
  });

  it("is in view with no host, or a host that cannot say", async () => {
    expect(await paneInView({ terminalFocused: true, host: null })).toBe(true);
    expect(await paneInView({ terminalFocused: true, host: host(false, async () => false) })).toBe(true);
    expect(await paneInView({ terminalFocused: true, host: host(true, async () => null) })).toBe(true);
  });

  it("asks a host that can say", async () => {
    expect(await paneInView({ terminalFocused: true, host: host(true, async () => false) })).toBe(false);
    expect(await paneInView({ terminalFocused: true, host: host(true, async () => true) })).toBe(true);
  });

  it("counts as in view when the host fails or does not answer in time", async () => {
    const failing = host(true, () => Promise.reject(new Error("socket gone")));
    expect(await paneInView({ terminalFocused: true, host: failing })).toBe(true);
    const silent = host(true, () => new Promise(() => undefined));
    expect(await paneInView({ terminalFocused: true, host: silent, timeoutMs: 10 })).toBe(true);
  });
});

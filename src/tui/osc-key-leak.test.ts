import { describe, expect, it } from "vitest";
import { OscKeyLeakFilter } from "./osc-key-leak.js";

const ALT_OPEN = "\u001b[93;3u";
const ALT_CLOSE = "\u001b[92;3u";

describe("OscKeyLeakFilter", () => {
  // The exact reads captured in tui.log: three pieces within one millisecond.
  it("removes the Alt-encoded reply split across three reads", () => {
    const f = new OscKeyLeakFilter();
    const out = [
      f.push(`${ALT_OPEN}4;`),
      f.push("150;rgb:afaf/d7d7/878"),
      f.push(`7${ALT_CLOSE}`),
    ];
    expect(out.join("")).toBe("");
    expect(f.holding()).toBe(false);
  });

  it("removes it from a single read and keeps the neighbours", () => {
    const f = new OscKeyLeakFilter();
    expect(f.push(`a${ALT_OPEN}4;150;rgb:afaf/d7d7/8787${ALT_CLOSE}b`)).toBe(
      "ab",
    );
  });

  it("removes the bracketed-paste form", () => {
    const f = new OscKeyLeakFilter();
    expect(f.push("\u001b[200~4;150;rgb:afaf/d7d7/8787\u001b[201~")).toBe("");
  });

  it("removes background and foreground replies too", () => {
    const f = new OscKeyLeakFilter();
    expect(f.push(`${ALT_OPEN}11;rgb:1010/1010/1010${ALT_CLOSE}`)).toBe("");
    expect(f.push(`${ALT_OPEN}10;#c0c0c0\u0007`)).toBe("");
  });

  it("does not hold or alter ordinary input", () => {
    const f = new OscKeyLeakFilter();
    for (const s of ["hello", "\u001b[A", "\u001b[27;2;73~", "4;150;rgb", "x\u001b"]) {
      expect(f.push(s)).toBe(s);
      expect(f.holding()).toBe(false);
    }
  });

  it("leaves a real Alt+] followed by ordinary text alone", () => {
    const f = new OscKeyLeakFilter();
    expect(f.push(`${ALT_OPEN}hello`)).toBe(`${ALT_OPEN}hello`);
  });

  it("does not touch an ordinary paste that is not a reply", () => {
    const f = new OscKeyLeakFilter();
    const paste = "\u001b[200~4;150;not a colour\u001b[201~";
    expect(f.push(paste)).toBe(paste);
  });

  it("holds an unfinished reply and can release it unchanged", () => {
    const f = new OscKeyLeakFilter();
    expect(f.push(`${ALT_OPEN}4;150;rgb:af`)).toBe("");
    expect(f.holding()).toBe(true);
    expect(f.take()).toBe(`${ALT_OPEN}4;150;rgb:af`);
    expect(f.holding()).toBe(false);
  });

  it("does not hold when told not to", () => {
    const f = new OscKeyLeakFilter();
    expect(f.push(`${ALT_OPEN}4;150;rgb:af`, false)).toBe(
      `${ALT_OPEN}4;150;rgb:af`,
    );
    expect(f.holding()).toBe(false);
  });
});

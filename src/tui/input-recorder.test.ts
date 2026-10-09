import { describe, expect, it } from "vitest";
import { InputRecorder, printable } from "./input-recorder.js";
import { OscKeyLeakFilter } from "./osc-key-leak.js";

describe("printable", () => {
  it("escapes control bytes and leaves text readable", () => {
    expect(printable("\u001b[93;3u4;150")).toBe("\\x1b[93;3u4;150");
    expect(printable("\u0007\r\n")).toBe("\\x07\\x0d\\x0a");
  });
});

describe("InputRecorder", () => {
  it("keeps only the most recent reads, oldest first, with ages", () => {
    let t = 1000;
    const r = new InputRecorder(() => t);
    for (let i = 0; i < 50; i++) {
      t += 10;
      r.record(`r${i}`);
    }
    t += 5;
    const snap = r.snapshot()!;
    expect(snap).toHaveLength(40);
    expect(snap[0]!.read).toBe("r10");
    expect(snap[39]!.read).toBe("r49");
    expect(snap[39]!.agoMs).toBe(5);
    expect(snap[0]!.agoMs).toBe(395);
  });

  it("throttles repeated dumps", () => {
    let t = 5000;
    const r = new InputRecorder(() => t);
    r.record("x");
    expect(r.snapshot()).not.toBeNull();
    t += 100;
    expect(r.snapshot()).toBeNull();
    t += 3000;
    expect(r.snapshot()).not.toBeNull();
  });
});

describe("OscKeyLeakFilter removal count", () => {
  it("reports each removed reply once", () => {
    const f = new OscKeyLeakFilter();
    f.push("\u001b[93;3u4;150;rgb:afaf/d7d7/8787\u001b[92;3u");
    f.push("\u001b[200~4;218;rgb:ffff/afaf/d7d7\u001b[201~");
    expect(f.takeRemoved()).toBe(2);
    expect(f.takeRemoved()).toBe(0);
  });

  it("reports nothing for ordinary input", () => {
    const f = new OscKeyLeakFilter();
    f.push("hello\u001b[A");
    expect(f.takeRemoved()).toBe(0);
  });
});

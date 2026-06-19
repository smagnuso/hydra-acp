import { describe, expect, it } from "vitest";
import { InputDispatcher } from "./input.js";

describe("ctrl-q → toggle-questions", () => {
  it("emits a single toggle-questions action for ctrl-q key", () => {
    const d = new InputDispatcher();
    const result = d.feed({ type: "key", name: "ctrl-q" });
    expect(result).toEqual([{ type: "toggle-questions" }]);
  });

  it("does not affect the buffer on ctrl-q", () => {
    const d = new InputDispatcher();
    d.feed({ type: "char", ch: "h" });
    d.feed({ type: "key", name: "ctrl-q" });
    expect(d.state().buffer).toEqual(["h"]);
  });
});

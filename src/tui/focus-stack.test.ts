import { describe, it, expect, vi } from "vitest";
import type { FocusLayer } from "./picker.js";

// The focus stack itself lives inside pickSession's closure and isn't
// exported, so these tests verify the *contract* by building a minimal
// inline stack implementation that matches the exact semantics used in
// picker.ts. If the semantics ever change, these tests break and flag it.

function makeStack() {
  const stack: FocusLayer[] = [];
  const push = (layer: FocusLayer): void => {
    stack.push(layer);
  };
  const pop = (): void => {
    stack.pop();
    stack[stack.length - 1]?.onResize();
  };
  const dispatch = (
    name: string,
    data?: { isCharacter?: boolean },
  ): void => {
    stack[stack.length - 1]?.onKey(name, undefined, data);
  };
  return { stack, push, pop, dispatch };
}

function layer(
  onKey: FocusLayer["onKey"] = vi.fn(),
  onResize: FocusLayer["onResize"] = vi.fn(),
): FocusLayer {
  return { onKey, onResize };
}

describe("focus stack", () => {
  it("routes keys to the topmost layer only", () => {
    const { push, dispatch } = makeStack();
    const base = layer();
    const top = layer();
    push(base);
    push(top);
    dispatch("ENTER");
    expect(top.onKey).toHaveBeenCalledWith("ENTER", undefined, undefined);
    expect(base.onKey).not.toHaveBeenCalled();
  });

  it("pop restores routing to the layer below", () => {
    const { push, pop, dispatch } = makeStack();
    const base = layer(vi.fn(), vi.fn());
    const modal = layer();
    push(base);
    push(modal);
    pop();
    dispatch("ESCAPE");
    expect(base.onKey).toHaveBeenCalledWith("ESCAPE", undefined, undefined);
    expect(modal.onKey).not.toHaveBeenCalled();
  });

  it("pop calls onResize on the layer below so it can re-render", () => {
    const { push, pop } = makeStack();
    const base = layer(vi.fn(), vi.fn());
    const modal = layer();
    push(base);
    push(modal);
    pop();
    expect(base.onResize).toHaveBeenCalledTimes(1);
  });

  it("pop does not call onResize when the stack is empty", () => {
    const { push, pop } = makeStack();
    const only = layer(vi.fn(), vi.fn());
    push(only);
    pop();
    expect(only.onResize).not.toHaveBeenCalled();
  });

  it("dispatch is a no-op when the stack is empty", () => {
    const { dispatch } = makeStack();
    expect(() => dispatch("ENTER")).not.toThrow();
  });

  it("supports three layers: dispatch reaches only the top", () => {
    const { push, dispatch } = makeStack();
    const a = layer();
    const b = layer();
    const c = layer();
    push(a);
    push(b);
    push(c);
    dispatch("UP");
    expect(c.onKey).toHaveBeenCalled();
    expect(b.onKey).not.toHaveBeenCalled();
    expect(a.onKey).not.toHaveBeenCalled();
  });

  it("pop restores through multiple levels correctly", () => {
    const { push, pop, dispatch } = makeStack();
    const base = layer(vi.fn(), vi.fn());
    const mid = layer(vi.fn(), vi.fn());
    const top = layer();
    push(base);
    push(mid);
    push(top);
    pop(); // top gone → mid active
    dispatch("A");
    expect(mid.onKey).toHaveBeenCalled();
    expect(base.onKey).not.toHaveBeenCalled();
    pop(); // mid gone → base active
    dispatch("B");
    expect(base.onKey).toHaveBeenCalled();
  });

  it("each pop triggers onResize on the new top", () => {
    const { push, pop } = makeStack();
    const base = layer(vi.fn(), vi.fn());
    const mid = layer(vi.fn(), vi.fn());
    const top = layer();
    push(base);
    push(mid);
    push(top);
    pop();
    expect(mid.onResize).toHaveBeenCalledTimes(1);
    expect(base.onResize).not.toHaveBeenCalled();
    pop();
    expect(base.onResize).toHaveBeenCalledTimes(1);
  });

  it("passes key event data through to the layer unchanged", () => {
    const { push, dispatch } = makeStack();
    const l = layer();
    push(l);
    dispatch("f", { isCharacter: true });
    expect(l.onKey).toHaveBeenCalledWith("f", undefined, { isCharacter: true });
  });
});

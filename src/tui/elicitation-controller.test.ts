import { describe, expect, it } from "vitest";
import { ElicitationController } from "./elicitation-controller.js";
import type { KeyEvent } from "./input.js";
import type { FormState } from "./modal-form.js";

const key = (name: string): KeyEvent => ({ type: "key", name }) as KeyEvent;

const form = (id: string, message = "Which?"): unknown => ({
  mode: "form",
  message,
  requestedSchema: {
    type: "object",
    properties: {
      q: {
        type: "string",
        oneOf: [
          { const: "a", title: "Alpha" },
          { const: "b", title: "Beta" },
        ],
      },
    },
  },
  _meta: { "hydra-acp": { elicitationId: id } },
});

function make(): { c: ElicitationController; shown: FormState[]; hidden: () => number } {
  const shown: FormState[] = [];
  let hidden = 0;
  const c = new ElicitationController({
    show: (f) => shown.push(f),
    hide: () => {
      hidden += 1;
    },
  });
  return { c, shown, hidden: () => hidden };
}

describe("ElicitationController", () => {
  it("returns null for a form it cannot render", () => {
    const { c, shown } = make();
    expect(
      c.request({ mode: "url", message: "x" }),
    ).toBeNull();
    expect(shown).toHaveLength(0);
  });

  it("shows a form and resolves with the wizard's answer", async () => {
    const { c, shown, hidden } = make();
    const pending = c.request(form("e1"))!;
    expect(shown).toHaveLength(1);
    expect(c.isActive).toBe(true);
    c.handleKey(key("enter"));
    await expect(pending).resolves.toEqual({ action: "accept", content: { q: "a" } });
    expect(c.isActive).toBe(false);
    expect(hidden()).toBe(1);
  });

  it("queues a second form until the first finishes", async () => {
    const { c, shown } = make();
    const first = c.request(form("e1", "First"))!;
    const second = c.request(form("e2", "Second"))!;
    expect(shown).toHaveLength(1);
    expect(shown[0]!.title).toContain("First");
    c.handleKey(key("enter"));
    await first;
    expect(shown).toHaveLength(2);
    expect(shown[1]!.title).toContain("Second");
    c.handleKey(key("escape"));
    await expect(second).resolves.toEqual({ action: "cancel" });
  });

  it("drops the active form when a sibling answered, then shows the next", async () => {
    const { c, shown } = make();
    const first = c.request(form("e1"))!;
    const second = c.request(form("e2"))!;
    c.dismissExternally("e1");
    await expect(first).resolves.toEqual({ action: "cancel" });
    expect(shown).toHaveLength(2);
    c.handleKey(key("enter"));
    await expect(second).resolves.toEqual({ action: "accept", content: { q: "a" } });
  });

  it("drops a queued form by id without disturbing the active one", async () => {
    const { c } = make();
    const first = c.request(form("e1"))!;
    const second = c.request(form("e2"))!;
    c.dismissExternally("e2");
    await expect(second).resolves.toEqual({ action: "cancel" });
    expect(c.isActive).toBe(true);
    c.handleKey(key("down"));
    c.handleKey(key("enter"));
    await expect(first).resolves.toEqual({ action: "accept", content: { q: "b" } });
  });

  it("ignores an unknown or non-string id", () => {
    const { c } = make();
    void c.request(form("e1"));
    c.dismissExternally("nope");
    c.dismissExternally(undefined);
    expect(c.isActive).toBe(true);
  });

  it("cancelAll answers the active and queued forms", async () => {
    const { c } = make();
    const first = c.request(form("e1"))!;
    const second = c.request(form("e2"))!;
    c.cancelAll();
    await expect(first).resolves.toEqual({ action: "cancel" });
    await expect(second).resolves.toEqual({ action: "cancel" });
    expect(c.isActive).toBe(false);
  });

  it("keys do nothing with no active form", () => {
    const { c, shown } = make();
    c.handleKey(key("enter"));
    expect(shown).toHaveLength(0);
  });
});

import { describe, expect, it } from "vitest";
import { isFirstPromptPlaceholderTitle } from "./session.js";

const LONG =
  "I need some help. I added a splatTimeout in the splat probes but I realize now I need that in the appliance query. Can you help?";

describe("isFirstPromptPlaceholderTitle", () => {
  it("matches an agent title clipped at 80 chars", () => {
    expect(isFirstPromptPlaceholderTitle(LONG.slice(0, 80), LONG)).toBe(true);
  });

  it("matches the daemon seed with a trailing ellipsis", () => {
    expect(isFirstPromptPlaceholderTitle(`${LONG.slice(0, 100)}…`, LONG)).toBe(true);
  });

  it("collapses whitespace on both sides", () => {
    const prompt = "first line of a long\n\nprompt that keeps going well past forty chars";
    const title = "first line of a long  prompt that keeps going";
    expect(isFirstPromptPlaceholderTitle(title, prompt)).toBe(true);
  });

  it("leaves a generated summary alone", () => {
    expect(isFirstPromptPlaceholderTitle("Splat probe timeout for appliance query", LONG)).toBe(false);
  });

  it("leaves a short title alone even if it is a prefix", () => {
    expect(isFirstPromptPlaceholderTitle("am I using wayland?", "am I using wayland? on this machine")).toBe(false);
  });

  it("handles a missing title", () => {
    expect(isFirstPromptPlaceholderTitle(undefined, LONG)).toBe(false);
  });
});

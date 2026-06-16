import { describe, it, expect } from "vitest";
import {
  HYDRA_COMMANDS,
  getHydraCommand,
  hydraCommandsAsAdvertised,
} from "./hydra-commands.js";

describe("HYDRA_COMMANDS", () => {
  it('includes a "compact" entry', () => {
    const compact = HYDRA_COMMANDS.find((c) => c.verb === "compact");
    expect(compact).toBeDefined();
    expect(compact!.name).toBe("hydra compact");
    expect(compact!.description).toContain("Compact this session's history");
    expect(compact!.description).toContain("recall_* tools");
  });

  it('places "compact" after "restart"', () => {
    const verbs = HYDRA_COMMANDS.map((c) => c.verb);
    const restartIdx = verbs.indexOf("restart");
    const compactIdx = verbs.indexOf("compact");
    expect(compactIdx).toBe(restartIdx + 1);
  });

  it("getHydraCommand returns the compact spec for verb 'compact'", () => {
    const spec = getHydraCommand("compact");
    expect(spec).toBeDefined();
    expect(spec!.verb).toBe("compact");
  });

  it("getHydraCommand returns undefined for unknown verbs", () => {
    expect(getHydraCommand("nonexistent")).toBeUndefined();
  });

  it("hydraCommandsAsAdvertised includes compact with description", () => {
    const advertised = hydraCommandsAsAdvertised();
    const compact = advertised.find((c) => c.name === "hydra compact");
    expect(compact).toBeDefined();
    expect(compact!.description).toContain("Compact this session's history");
  });
});

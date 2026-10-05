import { describe, expect, it } from "vitest";
import { elidedExtensionName, prefixedExtensionNames } from "./extension-names.js";

describe("elidedExtensionName", () => {
  it("strips either prefix, hydra-acp- first", () => {
    expect(elidedExtensionName("hydra-acp-planner")).toBe("planner");
    expect(elidedExtensionName("hydra-ahp")).toBe("ahp");
    expect(elidedExtensionName("hydra-acp-hydra-x")).toBe("hydra-x");
  });

  it("leaves other names and bare prefixes alone", () => {
    expect(elidedExtensionName("planner")).toBeUndefined();
    expect(elidedExtensionName("hydra-")).toBeUndefined();
  });
});

describe("prefixedExtensionNames", () => {
  it("lists the registered names a short form can stand for", () => {
    expect(prefixedExtensionNames("ahp")).toEqual(["hydra-acp-ahp", "hydra-ahp"]);
  });
});

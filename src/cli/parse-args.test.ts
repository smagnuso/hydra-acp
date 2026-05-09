import { describe, it, expect } from "vitest";
import { parseArgs, flagString, flagBool } from "./parse-args.js";

describe("parseArgs", () => {
  it("returns empty result for no args", () => {
    expect(parseArgs([])).toEqual({ positional: [], flags: {} });
  });

  it("collects bare positionals", () => {
    expect(parseArgs(["sessions", "list"])).toEqual({
      positional: ["sessions", "list"],
      flags: {},
    });
  });

  it("treats a lone --flag as a boolean true", () => {
    expect(parseArgs(["--help"])).toMatchObject({
      flags: { help: true },
    });
  });

  it("parses --key=value form", () => {
    expect(parseArgs(["--port=8080"])).toMatchObject({
      flags: { port: "8080" },
    });
  });

  it("parses --key value form (next token is the value)", () => {
    expect(parseArgs(["--session-id", "sess_abc"])).toMatchObject({
      flags: { "session-id": "sess_abc" },
    });
  });

  it("does not consume a following --flag as a value", () => {
    expect(parseArgs(["--help", "--version"])).toMatchObject({
      flags: { help: true, version: true },
    });
  });

  it("interleaves positionals and flags", () => {
    expect(
      parseArgs(["launch", "claude-code", "--role", "observer"]),
    ).toEqual({
      positional: ["launch", "claude-code"],
      flags: { role: "observer" },
    });
  });

  it("preserves last value when a flag is repeated", () => {
    expect(parseArgs(["--port=1", "--port=2"])).toMatchObject({
      flags: { port: "2" },
    });
  });

  it("handles equals form with empty value", () => {
    expect(parseArgs(["--name="])).toMatchObject({
      flags: { name: "" },
    });
  });

  it("recognizes the documented --rotate-token init quirk", () => {
    // Known limitation: a boolean-only flag followed by a positional
    // is parsed as flag=value because the parser cannot distinguish the
    // intent. Users should pass the positional first.
    expect(parseArgs(["--rotate-token", "init"])).toEqual({
      positional: [],
      flags: { "rotate-token": "init" },
    });
    expect(parseArgs(["init", "--rotate-token"])).toEqual({
      positional: ["init"],
      flags: { "rotate-token": true },
    });
  });
});

describe("flagString", () => {
  it("returns the value when set to a string", () => {
    expect(flagString({ port: "8080" }, "port")).toBe("8080");
  });

  it("returns undefined for missing flag", () => {
    expect(flagString({}, "port")).toBeUndefined();
  });

  it("returns undefined for boolean-true flags", () => {
    expect(flagString({ help: true }, "help")).toBeUndefined();
  });
});

describe("flagBool", () => {
  it("treats true as true", () => {
    expect(flagBool({ help: true }, "help")).toBe(true);
  });

  it("treats string 'true' as true", () => {
    expect(flagBool({ help: "true" }, "help")).toBe(true);
  });

  it("returns false for any other string", () => {
    expect(flagBool({ help: "false" }, "help")).toBe(false);
    expect(flagBool({ help: "1" }, "help")).toBe(false);
  });

  it("returns false for missing flag", () => {
    expect(flagBool({}, "help")).toBe(false);
  });
});

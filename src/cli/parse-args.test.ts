import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  parseArgs,
  flagString,
  flagBool,
  envKeyForFlag,
  resolveOption,
  validateKnownFlags,
} from "./parse-args.js";

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
    expect(parseArgs(["--session", "sess_abc"])).toMatchObject({
      flags: { session: "sess_abc" },
    });
  });

  it("does not consume a following --flag as a value", () => {
    expect(parseArgs(["--help", "--version"])).toMatchObject({
      flags: { help: true, version: true },
    });
  });

  it("interleaves positionals and flags", () => {
    expect(
      parseArgs(["launch", "claude-code", "--name", "foo"]),
    ).toEqual({
      positional: ["launch", "claude-code"],
      flags: { name: "foo" },
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

  it("does not consume a positional after a known-boolean flag", () => {
    // Both orderings of a boolean flag and a positional must parse the
    // same way — the boolean shouldn't slurp the next token.
    expect(parseArgs(["init", "--rotate-token"])).toEqual({
      positional: ["init"],
      flags: { "rotate-token": true },
    });
    expect(parseArgs(["--rotate-token", "init"])).toEqual({
      positional: ["init"],
      flags: { "rotate-token": true },
    });
    expect(
      parseArgs(["sessions", "import", "--info", "file.hydra"]),
    ).toEqual({
      positional: ["sessions", "import", "file.hydra"],
      flags: { info: true },
    });
    expect(
      parseArgs(["sessions", "import", "file.hydra", "--info"]),
    ).toEqual({
      positional: ["sessions", "import", "file.hydra"],
      flags: { info: true },
    });
  });

  it("treats --reattach as a pure boolean (no slurp)", () => {
    expect(parseArgs(["--reattach"])).toEqual({
      positional: [],
      flags: { reattach: true },
    });
    expect(parseArgs(["tui", "--reattach"])).toEqual({
      positional: ["tui"],
      flags: { reattach: true },
    });
  });

  it("treats --readonly as a pure boolean (no slurp)", () => {
    expect(parseArgs(["--readonly"])).toEqual({
      positional: [],
      flags: { readonly: true },
    });
    expect(parseArgs(["--readonly", "--session", "sess_abc"])).toEqual({
      positional: [],
      flags: { readonly: true, session: "sess_abc" },
    });
  });

  it("value-taking flags slurp the next token (no following value → true)", () => {
    // --session isn't in the boolean set, so the parser eats the
    // next non-flag token as its value. Bare --session yields true,
    // which the cli.ts dispatcher treats as "not set" via
    // readSessionInput's typeof-string check.
    expect(parseArgs(["--session", "sess_abc"])).toEqual({
      positional: [],
      flags: { session: "sess_abc" },
    });
    expect(parseArgs(["--session"])).toEqual({
      positional: [],
      flags: { session: true },
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

describe("envKeyForFlag", () => {
  it("maps kebab-case to HYDRA_ACP_UPPER_SNAKE", () => {
    expect(envKeyForFlag("name")).toBe("HYDRA_ACP_NAME");
    expect(envKeyForFlag("rotate-token")).toBe("HYDRA_ACP_ROTATE_TOKEN");
    expect(envKeyForFlag("agent")).toBe("HYDRA_ACP_AGENT");
    expect(envKeyForFlag("model")).toBe("HYDRA_ACP_MODEL");
  });
});

describe("resolveOption", () => {
  const SAVED = { ...process.env };

  beforeEach(() => {
    delete process.env.HYDRA_ACP_NAME;
    delete process.env.HYDRA_ACP_AGENT;
    delete process.env.HYDRA_ACP_MODEL;
  });

  afterEach(() => {
    Object.assign(process.env, SAVED);
  });

  it("prefers flag over env", () => {
    process.env.HYDRA_ACP_NAME = "from-env";
    expect(resolveOption({ name: "from-flag" }, "name")).toBe("from-flag");
  });

  it("falls back to env when flag is unset", () => {
    process.env.HYDRA_ACP_AGENT = "agent-from-env";
    expect(resolveOption({}, "agent")).toBe("agent-from-env");
  });

  it("returns undefined when neither is set", () => {
    expect(resolveOption({}, "agent")).toBeUndefined();
  });

  it("treats boolean-true flags as unset (only string flags carry values)", () => {
    process.env.HYDRA_ACP_NAME = "from-env";
    expect(resolveOption({ name: true }, "name")).toBe("from-env");
  });
});

describe("validateKnownFlags", () => {
  it("returns undefined for an empty flag map", () => {
    expect(validateKnownFlags({})).toBeUndefined();
  });

  it("accepts known boolean flags", () => {
    expect(
      validateKnownFlags({ help: true, version: true, reattach: true }),
    ).toBeUndefined();
  });

  it("accepts known value-taking flags", () => {
    expect(
      validateKnownFlags({ session: "sess_abc", agent: "claude" }),
    ).toBeUndefined();
  });

  it("accepts downstream-only flags consumed by sub-parsers", () => {
    // extension/transformer add and log tail flags must validate at the
    // top level too, since parseArgs sees them before dispatch.
    expect(
      validateKnownFlags({
        command: "foo",
        args: "a,b",
        env: "K=V",
        disabled: true,
        tail: "20",
        follow: true,
      }),
    ).toBeUndefined();
  });

  it("returns the name of an unknown flag", () => {
    expect(validateKnownFlags({ foo: true })).toBe("foo");
    expect(validateKnownFlags({ help: true, foo: "bar" })).toBe("foo");
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

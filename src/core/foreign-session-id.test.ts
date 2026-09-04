import { describe, it, expect } from "vitest";
import {
  formatForeignSessionId,
  parseForeignSessionId,
} from "./foreign-session-id.js";

describe("formatForeignSessionId", () => {
  it("joins name and localId with a colon", () => {
    expect(
      formatForeignSessionId({ name: "foo", localId: "hydra_session_abc" }),
    ).toBe("foo:hydra_session_abc");
  });
});

describe("parseForeignSessionId", () => {
  it("round-trips a formatted id", () => {
    const formatted = formatForeignSessionId({
      name: "foo",
      localId: "hydra_session_abc",
    });
    expect(parseForeignSessionId(formatted)).toEqual({
      name: "foo",
      localId: "hydra_session_abc",
    });
  });

  it("returns undefined for a bare local id (no colon)", () => {
    expect(parseForeignSessionId("hydra_session_abc")).toBeUndefined();
  });

  it("returns undefined when either side of the colon is empty", () => {
    expect(parseForeignSessionId(":hydra_session_abc")).toBeUndefined();
    expect(parseForeignSessionId("foo:")).toBeUndefined();
  });

  it("splits on the first colon only, in case a local id ever contained one", () => {
    expect(parseForeignSessionId("foo:bar:baz")).toEqual({
      name: "foo",
      localId: "bar:baz",
    });
  });
});

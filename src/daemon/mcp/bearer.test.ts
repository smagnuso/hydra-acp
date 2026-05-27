import { describe, it, expect } from "vitest";
import type { FastifyRequest } from "fastify";
import { extractBearer } from "./bearer.js";

function makeReq(authorization?: string): FastifyRequest {
  return {
    headers: authorization === undefined ? {} : { authorization },
  } as unknown as FastifyRequest;
}

describe("extractBearer", () => {
  it("returns undefined when no Authorization header is present", () => {
    expect(extractBearer(makeReq())).toBeUndefined();
  });

  it("returns undefined for non-Bearer schemes", () => {
    expect(extractBearer(makeReq("Basic abcdef"))).toBeUndefined();
    expect(extractBearer(makeReq("Token abc"))).toBeUndefined();
  });

  it("returns undefined for an empty token after the Bearer prefix", () => {
    expect(extractBearer(makeReq("Bearer "))).toBeUndefined();
    expect(extractBearer(makeReq("Bearer    "))).toBeUndefined();
  });

  it("returns the token for a well-formed Bearer header", () => {
    expect(extractBearer(makeReq("Bearer deadbeef"))).toBe("deadbeef");
  });

  it("trims surrounding whitespace around the token", () => {
    expect(extractBearer(makeReq("Bearer   deadbeef  "))).toBe("deadbeef");
  });

  it("is case-sensitive on the Bearer scheme keyword", () => {
    expect(extractBearer(makeReq("bearer deadbeef"))).toBeUndefined();
    expect(extractBearer(makeReq("BEARER deadbeef"))).toBeUndefined();
  });
});

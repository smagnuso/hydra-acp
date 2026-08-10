import { describe, expect, it, beforeEach } from "vitest";
import {
  MAX_MESSAGE_DEPTH,
  __resetBlockingEdgesForTests,
  blockingEdgeCount,
  registerBlockingEdge,
  wouldDeadlock,
} from "./message-guard.js";

describe("message-guard", () => {
  beforeEach(() => {
    __resetBlockingEdgesForTests();
  });

  it("has no opinion when nothing is in flight", () => {
    expect(wouldDeadlock("a", "b")).toBe(false);
  });

  // The case that hangs today: A blocks on B, then B's agent tries to
  // prompt A. B's prompt would queue behind A's in-flight turn, which
  // cannot finish until B answers.
  it("catches the direct A->B, B->A cycle", () => {
    registerBlockingEdge("a", "b");
    expect(wouldDeadlock("b", "a")).toBe(true);
  });

  it("catches a transitive cycle through a third session", () => {
    registerBlockingEdge("a", "b");
    registerBlockingEdge("b", "c");
    expect(wouldDeadlock("c", "a")).toBe(true);
  });

  it("allows the same direction twice", () => {
    registerBlockingEdge("a", "b");
    expect(wouldDeadlock("a", "b")).toBe(false);
  });

  it("allows an unrelated pair while others are blocked", () => {
    registerBlockingEdge("a", "b");
    expect(wouldDeadlock("c", "d")).toBe(false);
    expect(wouldDeadlock("b", "c")).toBe(false);
  });

  it("treats a session prompting itself mid-turn as a deadlock", () => {
    expect(wouldDeadlock("a", "a")).toBe(true);
  });

  it("stops caring once the edge is released", () => {
    const release = registerBlockingEdge("a", "b");
    expect(wouldDeadlock("b", "a")).toBe(true);
    release();
    expect(wouldDeadlock("b", "a")).toBe(false);
    expect(blockingEdgeCount()).toBe(0);
  });

  it("releases idempotently and only its own edge", () => {
    const releaseAB = registerBlockingEdge("a", "b");
    registerBlockingEdge("a", "c");
    releaseAB();
    releaseAB();
    expect(blockingEdgeCount()).toBe(1);
    expect(wouldDeadlock("c", "a")).toBe(true);
  });

  // A cycle in the live-edge graph must not wedge the walk itself.
  it("terminates on a cycle that doesn't involve the sender", () => {
    registerBlockingEdge("b", "c");
    registerBlockingEdge("c", "b");
    expect(wouldDeadlock("a", "b")).toBe(false);
  });

  it("bounds chains at a depth that still allows a real exchange", () => {
    // send (1), reply (2), follow-up (3) all fit; the fourth does not.
    expect(MAX_MESSAGE_DEPTH).toBeGreaterThanOrEqual(2);
    expect(MAX_MESSAGE_DEPTH).toBeLessThan(10);
  });
});

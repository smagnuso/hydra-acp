import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SessionStore, recordFromMemorySession } from "./session-store.js";

describe("SessionStore", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = process.env.HYDRA_ACP_HOME!;
  });

  it("writes a session record and reads it back", async () => {
    const store = new SessionStore();
    await store.write(
      recordFromMemorySession({
        sessionId: "hydra_session_abc",
        upstreamSessionId: "u_xyz",
        agentId: "claude-acp",
        cwd: "/work",
        title: "feature-X",
        agentArgs: ["-c", "x"],
      }),
    );
    const r = await store.read("hydra_session_abc");
    expect(r).toMatchObject({
      version: 1,
      sessionId: "hydra_session_abc",
      upstreamSessionId: "u_xyz",
      agentId: "claude-acp",
      cwd: "/work",
      title: "feature-X",
      agentArgs: ["-c", "x"],
    });
    expect(typeof r?.createdAt).toBe("string");
    expect(typeof r?.updatedAt).toBe("string");
  });

  it("returns undefined for missing sessions", async () => {
    const store = new SessionStore();
    expect(await store.read("hydra_session_does_not_exist")).toBeUndefined();
  });

  it("returns undefined for malformed JSON instead of throwing", async () => {
    const store = new SessionStore();
    await fs.mkdir(path.join(tmpHome, "sessions", "hydra_session_bad"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(tmpHome, "sessions", "hydra_session_bad", "meta.json"),
      "not json",
    );
    expect(await store.read("hydra_session_bad")).toBeUndefined();
  });

  it("delete is idempotent for missing files", async () => {
    const store = new SessionStore();
    await expect(store.delete("hydra_session_missing")).resolves.toBeUndefined();
  });

  it("rejects unsafe ids on write", async () => {
    const store = new SessionStore();
    await expect(
      store.write(
        recordFromMemorySession({
          sessionId: "../etc/passwd",
          upstreamSessionId: "u",
          agentId: "a",
          cwd: "/",
        }),
      ),
    ).rejects.toThrow(/unsafe/);
  });

  it("round-trips a currentUsage block", async () => {
    const store = new SessionStore();
    await store.write(
      recordFromMemorySession({
        sessionId: "hydra_session_usage",
        upstreamSessionId: "u",
        agentId: "claude-acp",
        cwd: "/w",
        currentUsage: {
          used: 1234,
          size: 200000,
          costAmount: 0.42,
          costCurrency: "USD",
        },
      }),
    );
    const r = await store.read("hydra_session_usage");
    expect(r?.currentUsage).toEqual({
      used: 1234,
      size: 200000,
      costAmount: 0.42,
      costCurrency: "USD",
    });
  });

  it("round-trips a compactionState block", async () => {
    const store = new SessionStore();
    const compactionState = {
      status: "running" as const,
      requestedAt: 1700000000000,
      iter: 2,
      worker: { upstreamSessionId: "upstream_abc", pid: 12345 },
    };
    await store.write(
      recordFromMemorySession({
        sessionId: "hydra_session_compaction",
        upstreamSessionId: "u",
        agentId: "claude-acp",
        cwd: "/w",
        compactionState,
      }),
    );
    const r = await store.read("hydra_session_compaction");
    expect(r?.compactionState).toEqual(compactionState);
  });

  it("list returns all valid records", async () => {
    const store = new SessionStore();
    for (const id of ["hydra_session_a", "hydra_session_b"]) {
      await store.write(
        recordFromMemorySession({
          sessionId: id,
          upstreamSessionId: `u_${id}`,
          agentId: "claude-acp",
          cwd: "/w",
        }),
      );
    }
    const records = await store.list();
    expect(records.map((r) => r.sessionId).sort()).toEqual([
      "hydra_session_a",
      "hydra_session_b",
    ]);
  });

  it("round-trips a single attention flag", async () => {
    const store = new SessionStore();
    await store.write(
      recordFromMemorySession({
        sessionId: "hydra_session_flag",
        upstreamSessionId: "u",
        agentId: "claude-acp",
        cwd: "/w",
        attentionFlags: [
          { source: "daemon", reason: "permission_request", raisedAt: 1700000000000, payload: { tool: "read_file" } },
        ],
      }),
    );
    const r = await store.read("hydra_session_flag");
    expect(r?.attentionFlags).toEqual([
      { source: "daemon", reason: "permission_request", raisedAt: 1700000000000, payload: { tool: "read_file" } },
    ]);
  });

  it("round-trips multiple flags with different sources and reasons", async () => {
    const store = new SessionStore();
    const flags = [
      { source: "daemon", reason: "perm_a", raisedAt: 1700000000000, payload: {} },
      { source: "extension-x", reason: "input_needed", raisedAt: 1700000001000, payload: { type: "confirm" } },
      { source: "daemon", reason: "perm_b", raisedAt: 1700000002000, payload: { tool: "write_file" } },
    ];
    await store.write(
      recordFromMemorySession({
        sessionId: "hydra_session_multi_flag",
        upstreamSessionId: "u",
        agentId: "claude-acp",
        cwd: "/w",
        attentionFlags: flags,
      }),
    );
    const r = await store.read("hydra_session_multi_flag");
    expect(r?.attentionFlags).toEqual(flags);
  });

  it("round-trips an empty attention flags array", async () => {
    const store = new SessionStore();
    await store.write(
      recordFromMemorySession({
        sessionId: "hydra_session_empty_flag",
        upstreamSessionId: "u",
        agentId: "claude-acp",
        cwd: "/w",
        attentionFlags: [],
      }),
    );
    const r = await store.read("hydra_session_empty_flag");
    expect(r?.attentionFlags).toEqual([]);
  });
});

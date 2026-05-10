import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionStore, recordFromMemorySession } from "./session-store.js";

describe("SessionStore", () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "acp-hydra-store-"));
    process.env.ACP_HYDRA_HOME = tmpHome;
  });

  afterEach(async () => {
    delete process.env.ACP_HYDRA_HOME;
    await fs.rm(tmpHome, { recursive: true, force: true });
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
    await fs.mkdir(path.join(tmpHome, "sessions"), { recursive: true });
    await fs.writeFile(
      path.join(tmpHome, "sessions", "hydra_session_bad.json"),
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
});

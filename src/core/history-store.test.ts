import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import { HistoryStore } from "./history-store.js";
import { paths } from "./paths.js";

describe("HistoryStore", () => {
  it("appends entries and reads them back in order", async () => {
    const store = new HistoryStore();
    await store.append("hydra_session_abc", {
      method: "session/update",
      params: { sessionId: "hydra_session_abc", update: { foo: 1 } },
      recordedAt: 100,
    });
    await store.append("hydra_session_abc", {
      method: "session/update",
      params: { sessionId: "hydra_session_abc", update: { foo: 2 } },
      recordedAt: 200,
    });
    const loaded = await store.load("hydra_session_abc");
    expect(loaded).toEqual([
      {
        method: "session/update",
        params: { sessionId: "hydra_session_abc", update: { foo: 1 } },
        recordedAt: 100,
      },
      {
        method: "session/update",
        params: { sessionId: "hydra_session_abc", update: { foo: 2 } },
        recordedAt: 200,
      },
    ]);
  });

  it("rewrite replaces the file contents", async () => {
    const store = new HistoryStore();
    await store.append("hydra_session_abc", {
      method: "a",
      params: {},
      recordedAt: 1,
    });
    await store.append("hydra_session_abc", {
      method: "b",
      params: {},
      recordedAt: 2,
    });
    await store.rewrite("hydra_session_abc", [
      { method: "z", params: {}, recordedAt: 9 },
    ]);
    const loaded = await store.load("hydra_session_abc");
    expect(loaded).toEqual([{ method: "z", params: {}, recordedAt: 9 }]);
  });

  it("rewrite with an empty array truncates the file", async () => {
    const store = new HistoryStore();
    await store.append("hydra_session_abc", {
      method: "a",
      params: {},
      recordedAt: 1,
    });
    await store.rewrite("hydra_session_abc", []);
    expect(await store.load("hydra_session_abc")).toEqual([]);
  });

  it("load returns [] for a missing history file", async () => {
    const store = new HistoryStore();
    expect(await store.load("hydra_session_missing")).toEqual([]);
  });

  it("delete is idempotent for missing files", async () => {
    const store = new HistoryStore();
    await expect(store.delete("hydra_session_missing")).resolves.toBeUndefined();
  });

  it("skips malformed lines instead of throwing", async () => {
    const store = new HistoryStore();
    await fs.mkdir(paths.sessionDir("hydra_session_abc"), { recursive: true });
    await fs.writeFile(
      paths.historyFile("hydra_session_abc"),
      ['{"method":"a","params":{},"recordedAt":1}', "not json", "", '{"method":"b","params":{},"recordedAt":2}'].join(
        "\n",
      ) + "\n",
    );
    const loaded = await store.load("hydra_session_abc");
    expect(loaded.map((e) => e.method)).toEqual(["a", "b"]);
  });

  it("rejects unsafe session ids silently (no write)", async () => {
    const store = new HistoryStore();
    await store.append("../etc/passwd", {
      method: "a",
      params: {},
      recordedAt: 1,
    });
    // Nothing should have been created under sessions/.
    await expect(fs.access(paths.sessionsDir())).rejects.toThrow();
  });

  it("serializes concurrent appends per session id", async () => {
    const store = new HistoryStore();
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 50; i++) {
      writes.push(
        store.append("hydra_session_abc", {
          method: "session/update",
          params: { i },
          recordedAt: i,
        }),
      );
    }
    await Promise.all(writes);
    const loaded = await store.load("hydra_session_abc");
    expect(loaded).toHaveLength(50);
    expect(loaded.map((e) => e.recordedAt)).toEqual(
      Array.from({ length: 50 }, (_, i) => i),
    );
  });

  it("caps load at 1000 entries (tail) when the file grew unbounded", async () => {
    const store = new HistoryStore();
    await fs.mkdir(paths.sessionDir("hydra_session_abc"), { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < 1500; i++) {
      lines.push(JSON.stringify({ method: "x", params: { i }, recordedAt: i }));
    }
    await fs.writeFile(
      paths.historyFile("hydra_session_abc"),
      lines.join("\n") + "\n",
    );
    const loaded = await store.load("hydra_session_abc");
    expect(loaded).toHaveLength(1000);
    // Should be the tail (entries 500..1499).
    expect(loaded[0]?.recordedAt).toBe(500);
    expect(loaded[loaded.length - 1]?.recordedAt).toBe(1499);
  });
});

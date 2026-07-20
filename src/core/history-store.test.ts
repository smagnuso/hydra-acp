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
    expect(loaded[0]?.recordedAt).toBe(500);
    expect(loaded[loaded.length - 1]?.recordedAt).toBe(1499);
  });

  it("flushAll awaits every in-flight append before resolving", async () => {
    const store = new HistoryStore();
    store.append("hydra_session_abc", {
      method: "session/update",
      params: { sessionId: "hydra_session_abc", update: { foo: 1 } },
      recordedAt: 100,
    });
    store.append("hydra_session_def", {
      method: "session/update",
      params: { sessionId: "hydra_session_def", update: { foo: 2 } },
      recordedAt: 200,
    });
    await store.flushAll();
    const a = await store.load("hydra_session_abc");
    const b = await store.load("hydra_session_def");
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it("flushAll is a no-op when there is no pending work", async () => {
    const store = new HistoryStore();
    await expect(store.flushAll()).resolves.toBeUndefined();
  });

  it("respects a custom maxEntries cap on load", async () => {
    const store = new HistoryStore({ maxEntries: 50 });
    await fs.mkdir(paths.sessionDir("hydra_session_abc"), { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) {
      lines.push(JSON.stringify({ method: "x", params: { i }, recordedAt: i }));
    }
    await fs.writeFile(
      paths.historyFile("hydra_session_abc"),
      lines.join("\n") + "\n",
    );
    const loaded = await store.load("hydra_session_abc");
    expect(loaded).toHaveLength(50);
    expect(loaded[0]?.recordedAt).toBe(150);
    expect(loaded[loaded.length - 1]?.recordedAt).toBe(199);
  });

  it("spills evicted head entries to history.jsonl.1 on compact", async () => {
    const store = new HistoryStore({ archiveMaxBytes: 10_000_000, archiveTiers: 10 });
    const sid = "hydra_session_spill";
    for (let i = 0; i < 25; i++) {
      await store.append(sid, { method: "x", params: { i }, recordedAt: i });
    }
    await store.compact(sid, 10);
    const live = await store.load(sid);
    expect(live).toHaveLength(10);
    expect(live[0]?.recordedAt).toBe(15);
    const archives = await store.listArchives(sid);
    expect(archives).toHaveLength(1);
    expect(archives[0]?.index).toBe(1);
    const spilled = await store.loadArchives(sid);
    expect(spilled).toHaveLength(15);
    expect(spilled[0]?.recordedAt).toBe(0);
    expect(spilled[spilled.length - 1]?.recordedAt).toBe(14);
  });

  it("rolls to history.jsonl.2 once the current archive exceeds archiveMaxBytes", async () => {
    // Tiny byte cap so a single spill batch fills the current archive
    // and the next compact must open .2.
    const store = new HistoryStore({ archiveMaxBytes: 200, archiveTiers: 10 });
    const sid = "hydra_session_roll";
    for (let i = 0; i < 30; i++) {
      await store.append(sid, { method: "x", params: { i }, recordedAt: i });
    }
    await store.compact(sid, 10);
    for (let i = 30; i < 60; i++) {
      await store.append(sid, { method: "x", params: { i }, recordedAt: i });
    }
    await store.compact(sid, 10);
    const archives = await store.listArchives(sid);
    expect(archives.map((a) => a.index)).toEqual([1, 2]);
    const all = await store.loadArchives(sid);
    // Every non-tail entry (0..49) should be preserved across the two
    // archives, in chronological order.
    expect(all.map((e) => (e.params as { i: number }).i)).toEqual(
      Array.from({ length: 50 }, (_, i) => i),
    );
  });

  it("evicts the oldest archive when the tier cap would be exceeded", async () => {
    // Tier cap of 2 with a tiny byte budget forces .1 to be dropped as
    // soon as a spill would create a .3.
    const store = new HistoryStore({ archiveMaxBytes: 100, archiveTiers: 2 });
    const sid = "hydra_session_evict";
    for (let round = 0; round < 3; round++) {
      const base = round * 30;
      for (let i = 0; i < 30; i++) {
        await store.append(sid, {
          method: "x",
          params: { i: base + i },
          recordedAt: base + i,
        });
      }
      await store.compact(sid, 10);
    }
    const archives = await store.listArchives(sid);
    // Only two archives ever coexist. Indices march forward
    // monotonically (audit trail), so after the third spill we see
    // .2 and .3, and .1 is gone.
    expect(archives.map((a) => a.index)).toEqual([2, 3]);
    const survived = await store.loadArchives(sid);
    // .1 contained the very first batch (ids 0..19), which was
    // deliberately dropped when .3 was created.
    const firstId = (survived[0]?.params as { i: number }).i;
    expect(firstId).toBeGreaterThan(0);
  });

  it("resurrects the archive index by scanning the session dir", async () => {
    // Pre-populate an archive on disk, then create a fresh HistoryStore
    // (simulating a daemon restart) and verify the next spill goes to
    // the correct existing/rolled archive rather than clobbering.
    const sid = "hydra_session_resume";
    await fs.mkdir(paths.sessionDir(sid), { recursive: true });
    await fs.writeFile(
      paths.historyArchiveFile(sid, 3),
      JSON.stringify({ method: "old", params: {}, recordedAt: -1 }) + "\n",
    );
    const store = new HistoryStore({ archiveMaxBytes: 10_000_000, archiveTiers: 10 });
    for (let i = 0; i < 15; i++) {
      await store.append(sid, { method: "x", params: { i }, recordedAt: i });
    }
    await store.compact(sid, 5);
    const archives = await store.listArchives(sid);
    // The existing .3 (well under cap) receives the spill; no new
    // archive is created on resurrect.
    expect(archives.map((a) => a.index)).toEqual([3]);
    const spilled = await store.loadArchives(sid);
    expect(spilled[0]?.method).toBe("old");
    expect(spilled).toHaveLength(11);
  });

  it("archiveMaxBytes=0 disables spill (compact drops the head silently)", async () => {
    const store = new HistoryStore({ archiveMaxBytes: 0 });
    const sid = "hydra_session_no_spill";
    for (let i = 0; i < 20; i++) {
      await store.append(sid, { method: "x", params: { i }, recordedAt: i });
    }
    await store.compact(sid, 5);
    const archives = await store.listArchives(sid);
    expect(archives).toEqual([]);
    const live = await store.load(sid);
    expect(live).toHaveLength(5);
  });

  it("delete removes the archive files too", async () => {
    const store = new HistoryStore({ archiveMaxBytes: 10_000_000, archiveTiers: 10 });
    const sid = "hydra_session_del";
    for (let i = 0; i < 20; i++) {
      await store.append(sid, { method: "x", params: { i }, recordedAt: i });
    }
    await store.compact(sid, 5);
    expect(await store.listArchives(sid)).toHaveLength(1);
    await store.delete(sid);
    await expect(fs.access(paths.historyArchiveFile(sid, 1))).rejects.toThrow();
  });

  it("externalizes heavy tool content to blobs and hydrates on load", async () => {
    const store = new HistoryStore();
    const sid = "hydra_session_blob";
    const big = "x".repeat(20_000);
    const entry = {
      method: "session/update",
      params: {
        sessionId: sid,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "e1",
          status: "completed",
          content: [{ type: "diff", path: "/repo/foo.ts", oldText: big, newText: big + "z" }],
        },
      },
      recordedAt: 1,
    };
    await store.append(sid, entry);

    // On disk: history.jsonl is tiny (refs), blobs live under tools/.
    const onDisk = await fs.readFile(paths.historyFile(sid), "utf8");
    expect(onDisk).not.toContain(big);
    expect(onDisk).toContain("__hydraBlob");
    expect(onDisk.length).toBeLessThan(2000);
    const blobFiles = await fs.readdir(paths.toolsDir(sid));
    expect(blobFiles.length).toBeGreaterThan(0);

    // load() hydrates back to the original inline shape.
    const hydrated = await store.load(sid);
    expect(hydrated).toEqual([entry]);

    // Lean load leaves refs in place.
    const lean = await store.load(sid, { tools: "references" });
    const block = (lean[0]!.params as { update: { content: Array<Record<string, unknown>> } })
      .update.content[0]!;
    expect(typeof block.oldText).toBe("object");

    // delete drops the blob store too.
    await store.delete(sid);
    await expect(fs.access(paths.toolsDir(sid))).rejects.toThrow();
  });
});

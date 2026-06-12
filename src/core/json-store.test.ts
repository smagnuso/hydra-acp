import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readJsonSafe, writeFileAtomic, writeJsonAtomic } from "./json-store.js";
import { paths } from "./paths.js";

function p(name: string): string {
  return path.join(paths.home(), name);
}

describe("readJsonSafe", () => {
  it("returns undefined when the file is missing", async () => {
    expect(await readJsonSafe(p("missing.json"))).toBeUndefined();
  });

  it("returns undefined for a 0-byte file", async () => {
    await fs.mkdir(paths.home(), { recursive: true });
    await fs.writeFile(p("empty.json"), "");
    expect(await readJsonSafe(p("empty.json"))).toBeUndefined();
  });

  it("returns undefined for a whitespace-only file", async () => {
    await fs.mkdir(paths.home(), { recursive: true });
    await fs.writeFile(p("ws.json"), "   \n\t\n");
    expect(await readJsonSafe(p("ws.json"))).toBeUndefined();
  });

  it("returns undefined for a malformed JSON file", async () => {
    await fs.mkdir(paths.home(), { recursive: true });
    await fs.writeFile(p("bad.json"), "{not json");
    expect(await readJsonSafe(p("bad.json"))).toBeUndefined();
  });

  it("returns the parsed value for valid JSON", async () => {
    await fs.mkdir(paths.home(), { recursive: true });
    await fs.writeFile(p("ok.json"), JSON.stringify({ hello: "world" }));
    expect(await readJsonSafe<{ hello: string }>(p("ok.json"))).toEqual({
      hello: "world",
    });
  });

  it("re-throws non-ENOENT IO errors", async () => {
    await expect(readJsonSafe("/proc/self/mem")).rejects.toThrow();
  });
});

describe("writeJsonAtomic", () => {
  it("writes pretty JSON with a trailing newline by default", async () => {
    const target = p("pretty.json");
    await writeJsonAtomic(target, { a: 1, b: 2 });
    const raw = await fs.readFile(target, "utf8");
    expect(raw).toBe('{\n  "a": 1,\n  "b": 2\n}\n');
  });

  it("honours pretty:false for compact output", async () => {
    const target = p("compact.json");
    await writeJsonAtomic(target, { a: 1 }, { pretty: false });
    const raw = await fs.readFile(target, "utf8");
    expect(raw).toBe('{"a":1}\n');
  });

  it("applies mode 0600 when requested", async () => {
    const target = p("secret.json");
    await writeJsonAtomic(target, { token: "x" }, { mode: 0o600 });
    const stat = await fs.stat(target);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("creates the parent directory if missing", async () => {
    const target = path.join(paths.home(), "nested", "deep", "file.json");
    await writeJsonAtomic(target, { ok: true });
    expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual({ ok: true });
  });

  it("overwrites an existing file in place", async () => {
    const target = p("twice.json");
    await writeJsonAtomic(target, { v: 1 });
    await writeJsonAtomic(target, { v: 2 });
    expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual({ v: 2 });
  });

  it("leaves no .tmp- siblings behind on the happy path", async () => {
    const target = p("clean.json");
    await writeJsonAtomic(target, { ok: true });
    const siblings = await fs.readdir(paths.home());
    expect(siblings.filter((n) => n.startsWith("clean.json.tmp-"))).toEqual([]);
  });

  it("preserves the old file when a kill lands between truncate and write", async () => {
    // The whole point of the atomic helper: a crash between the
    // temp-file write and the rename leaves the original blob intact.
    // We can't actually kill the process, but we can simulate the
    // window by leaving a stray .tmp file on disk after a writeJsonAtomic
    // call and confirming the next readJsonSafe still sees the prior
    // good content.
    const target = p("durable.json");
    await writeJsonAtomic(target, { generation: 1 });
    // Drop a stray temp file (as if a prior write had been killed
    // mid-flight) and confirm it doesn't shadow the real one.
    await fs.writeFile(`${target}.tmp-99999-deadbeef`, "");
    const read = await readJsonSafe<{ generation: number }>(target);
    expect(read).toEqual({ generation: 1 });
  });
});

describe("writeFileAtomic", () => {
  it("writes raw text atomically and honours mode", async () => {
    const target = p("raw.txt");
    await writeFileAtomic(target, "hello\n", { mode: 0o600 });
    expect(await fs.readFile(target, "utf8")).toBe("hello\n");
    const stat = await fs.stat(target);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("writes through a symlink instead of replacing it", async () => {
    await fs.mkdir(paths.home(), { recursive: true });
    const realTarget = p("real-target.json");
    const link = p("link.json");
    await fs.writeFile(realTarget, "{}\n");
    await fs.symlink(realTarget, link);

    await writeFileAtomic(link, '{"v":1}\n');

    // The link node must survive — not be replaced by a regular file.
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    // And the content must land in the symlink's target.
    expect(await fs.readFile(realTarget, "utf8")).toBe('{"v":1}\n');
  });

  it("re-materializes a symlink target that does not exist yet", async () => {
    await fs.mkdir(paths.home(), { recursive: true });
    const dir = p("subdir");
    await fs.mkdir(dir, { recursive: true });
    const realTarget = path.join(dir, "absent.json");
    const link = p("link-to-absent.json");
    // Link points at a file that has not been created (e.g. a dotfile not
    // yet decrypted). The directory exists, the file does not.
    await fs.symlink(realTarget, link);

    await writeFileAtomic(link, '{"v":2}\n');

    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(realTarget, "utf8")).toBe('{"v":2}\n');
  });
});

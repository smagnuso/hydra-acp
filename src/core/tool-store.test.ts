import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import {
  putToolBlob,
  getToolBlob,
  readToolBlobGz,
  writeToolBlobGz,
  deleteToolBlobs,
  setToolBlobCompression,
} from "./tool-store.js";
import { paths } from "./paths.js";

const SID = "hydra_session_blobstore";

describe("tool-store (gzip blobs)", () => {
  it("round-trips content through a .gz file", async () => {
    const text = "diff body ".repeat(500);
    const hash = await putToolBlob(SID, text);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    // On disk it's gzipped under <hash>.gz, smaller than the raw text.
    const file = `${paths.toolBlobFile(SID, hash!)}.gz`;
    const onDisk = await fs.readFile(file);
    expect(onDisk.length).toBeLessThan(text.length);
    expect(gunzipSync(onDisk).toString("utf8")).toBe(text);
    // getToolBlob decompresses back to the original.
    expect(await getToolBlob(SID, hash!)).toBe(text);
    await deleteToolBlobs(SID);
  });

  it("dedupes identical content to one file", async () => {
    const text = "x".repeat(5000);
    const h1 = await putToolBlob(SID, text);
    const h2 = await putToolBlob(SID, text);
    expect(h1).toBe(h2);
    const files = await fs.readdir(paths.toolsDir(SID));
    expect(files).toEqual([`${h1}.gz`]);
    await deleteToolBlobs(SID);
  });

  it("reads a legacy plain (uncompressed) blob via fallback", async () => {
    const text = "legacy plain blob";
    const hash = "a".repeat(64);
    await fs.mkdir(paths.toolsDir(SID), { recursive: true });
    // Write a pre-compression plain file named <hash> (no .gz).
    await fs.writeFile(paths.toolBlobFile(SID, hash), text);
    expect(await getToolBlob(SID, hash)).toBe(text);
    // readToolBlobGz compresses it on the fly for bundling.
    const gz = await readToolBlobGz(SID, hash);
    expect(gz).not.toBeNull();
    expect(gunzipSync(gz!).toString("utf8")).toBe(text);
    await deleteToolBlobs(SID);
  });

  it("writeToolBlobGz stores bundle bytes that getToolBlob can read", async () => {
    const text = "imported blob content";
    const hash = await putToolBlob(SID, text); // produces the gz bytes on disk
    const gz = await readToolBlobGz(SID, hash!);
    await deleteToolBlobs(SID); // wipe, then import the bytes elsewhere
    await writeToolBlobGz(SID, hash!, gz!);
    expect(await getToolBlob(SID, hash!)).toBe(text);
    await deleteToolBlobs(SID);
  });

  it("writes plain blobs (no .gz) when compression is disabled, still readable", async () => {
    try {
      setToolBlobCompression(false);
      const text = "uncompressed on purpose ".repeat(100);
      const hash = await putToolBlob(SID, text);
      const files = await fs.readdir(paths.toolsDir(SID));
      expect(files).toEqual([hash!]); // plain <hash>, no .gz
      expect(await getToolBlob(SID, hash!)).toBe(text);
      // dedup still skips a second write regardless of form
      const again = await putToolBlob(SID, text);
      expect(again).toBe(hash);
      expect(await fs.readdir(paths.toolsDir(SID))).toHaveLength(1);
    } finally {
      setToolBlobCompression(true);
      await deleteToolBlobs(SID);
    }
  });

  it("returns null for missing / malformed", async () => {
    expect(await getToolBlob(SID, "b".repeat(64))).toBeNull();
    expect(await getToolBlob(SID, "not-a-hash")).toBeNull();
    expect(await putToolBlob("../bad", "x")).toBeNull();
  });
});

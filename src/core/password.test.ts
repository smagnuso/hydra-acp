import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  deletePassword,
  hasPassword,
  setPassword,
  verifyPassword,
} from "./password.js";
import { paths } from "./paths.js";

function hashPath(): string {
  return path.join(paths.home(), "password-hash");
}

describe("password", () => {
  it("hasPassword is false when no hash file exists", async () => {
    expect(await hasPassword()).toBe(false);
  });

  it("setPassword writes the hash file with mode 0600", async () => {
    await setPassword("correct horse battery staple");
    expect(await hasPassword()).toBe(true);
    const stat = await fs.stat(hashPath());
    expect(stat.mode & 0o777).toBe(0o600);
    const text = (await fs.readFile(hashPath(), "utf8")).trim();
    expect(text.startsWith("scrypt$")).toBe(true);
    // scrypt$N$r$p$salt$key -> 6 fields
    expect(text.split("$")).toHaveLength(6);
  });

  it("verifyPassword returns true for the correct password", async () => {
    await setPassword("hunter2");
    expect(await verifyPassword("hunter2")).toBe(true);
  });

  it("verifyPassword returns false for the wrong password", async () => {
    await setPassword("hunter2");
    expect(await verifyPassword("hunter3")).toBe(false);
  });

  it("verifyPassword returns false when no hash file exists", async () => {
    expect(await verifyPassword("anything")).toBe(false);
  });

  it("verifyPassword returns false for empty password input", async () => {
    await setPassword("hunter2");
    expect(await verifyPassword("")).toBe(false);
  });

  it("verifyPassword returns false on a corrupted hash file", async () => {
    await fs.mkdir(paths.home(), { recursive: true });
    await fs.writeFile(hashPath(), "not-a-valid-hash\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    expect(await verifyPassword("hunter2")).toBe(false);
  });

  it("setPassword overwrites an existing hash", async () => {
    await setPassword("first");
    await setPassword("second");
    expect(await verifyPassword("first")).toBe(false);
    expect(await verifyPassword("second")).toBe(true);
  });

  it("setPassword uses a distinct salt each call", async () => {
    await setPassword("same-password");
    const a = (await fs.readFile(hashPath(), "utf8")).trim();
    await setPassword("same-password");
    const b = (await fs.readFile(hashPath(), "utf8")).trim();
    expect(a).not.toBe(b);
  });

  it("setPassword rejects empty input", async () => {
    await expect(setPassword("")).rejects.toThrow();
  });

  it("deletePassword removes the hash file", async () => {
    await setPassword("anything");
    await deletePassword();
    expect(await hasPassword()).toBe(false);
  });

  it("deletePassword is a no-op when the file is absent", async () => {
    await expect(deletePassword()).resolves.toBeUndefined();
  });
});

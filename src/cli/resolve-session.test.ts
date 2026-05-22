import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  readSessionInput,
  resolveSessionFlag,
} from "./resolve-session.js";
import { writeServiceToken } from "../core/service-token.js";
import { RemotesStore } from "../core/remotes-store.js";

describe("readSessionInput", () => {
  let originalEnv: string | undefined;
  beforeEach(() => {
    originalEnv = process.env.HYDRA_ACP_SESSION;
    delete process.env.HYDRA_ACP_SESSION;
  });
  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.HYDRA_ACP_SESSION;
    } else {
      process.env.HYDRA_ACP_SESSION = originalEnv;
    }
  });

  it("returns --session flag when present", () => {
    expect(readSessionInput({ session: "abc" })).toBe("abc");
  });

  it("returns env var when --session flag is absent", () => {
    process.env.HYDRA_ACP_SESSION = "from-env";
    expect(readSessionInput({})).toBe("from-env");
  });

  it("flag wins over env", () => {
    process.env.HYDRA_ACP_SESSION = "from-env";
    expect(readSessionInput({ session: "from-flag" })).toBe("from-flag");
  });

  it("ignores bare boolean --session", () => {
    expect(readSessionInput({ session: true })).toBeUndefined();
  });

  it("returns undefined when nothing is set", () => {
    expect(readSessionInput({})).toBeUndefined();
  });
});

describe("resolveSessionFlag", () => {
  it("returns undefined when no value is given", async () => {
    expect(
      await resolveSessionFlag(undefined, { allowPrompt: true }),
    ).toBeUndefined();
  });

  it("returns undefined for whitespace-only values", async () => {
    expect(
      await resolveSessionFlag("   ", { allowPrompt: true }),
    ).toBeUndefined();
  });

  it("treats a bare id as local and trims whitespace", async () => {
    await writeServiceToken("svc");
    const r = await resolveSessionFlag(" sess_abc ", { allowPrompt: true });
    expect(r?.fromUrl).toBe(false);
    expect(r?.sessionId).toBe("sess_abc");
    expect(r?.target.isLocal).toBe(true);
    expect(r?.target.token).toBe("svc");
  });

  it("treats a hydra:// URL as remote and extracts the session id", async () => {
    await writeServiceToken("svc");
    const r = await resolveSessionFlag("hydra://127.0.0.1/sess_xyz", {
      allowPrompt: true,
    });
    expect(r?.fromUrl).toBe(true);
    expect(r?.sessionId).toBe("sess_xyz");
    expect(r?.target.isLocal).toBe(true);
  });

  it("URL with no path leaves sessionId undefined", async () => {
    await writeServiceToken("svc");
    const r = await resolveSessionFlag("hydra://127.0.0.1/", {
      allowPrompt: true,
    });
    expect(r?.fromUrl).toBe(true);
    expect(r?.sessionId).toBeUndefined();
  });

  it("non-loopback URL with no cached token and allowPrompt=false throws", async () => {
    await expect(
      resolveSessionFlag("hydra://abc.ngrok.app/sess_x", {
        allowPrompt: false,
      }),
    ).rejects.toThrow(/No cached credentials/);
  });

  it("non-loopback URL with cached token resolves cleanly", async () => {
    const store = await RemotesStore.load();
    await store.set("abc.ngrok.app", 443, {
      token: "tok-cached",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const r = await resolveSessionFlag("hydra://abc.ngrok.app/sess_x", {
      allowPrompt: false,
    });
    expect(r?.target.token).toBe("tok-cached");
    expect(r?.target.isLocal).toBe(false);
    expect(r?.sessionId).toBe("sess_x");
  });

  it("surfaces parse errors for malformed hydra URLs", async () => {
    await expect(
      resolveSessionFlag("hydra:///nohost", { allowPrompt: true }),
    ).rejects.toThrow(/host/);
  });
});

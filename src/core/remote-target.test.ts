import { describe, it, expect } from "vitest";
import {
  NoCachedCredentialError,
  resolveLocalTarget,
  resolveRemoteTarget,
  targetFromParsedUrl,
} from "./remote-target.js";
import { defaultConfig, type HydraConfig } from "./config.js";
import { parseHydraUrl } from "./remote-url.js";
import { writeServiceToken } from "./service-token.js";
import { RemotesStore } from "./remotes-store.js";

function withTls(cfg: HydraConfig): HydraConfig {
  return {
    ...cfg,
    daemon: {
      ...cfg.daemon,
      tls: { cert: "/dev/null/cert", key: "/dev/null/key" },
    },
  };
}

describe("resolveLocalTarget", () => {
  it("builds http/ws URLs and marks loopback for default config", async () => {
    await writeServiceToken("hydra_token_test_local");
    const target = await resolveLocalTarget(defaultConfig());
    expect(target.baseUrl).toBe("http://127.0.0.1:55514");
    expect(target.wsUrl).toBe("ws://127.0.0.1:55514/acp");
    expect(target.token).toBe("hydra_token_test_local");
    expect(target.display).toBe("127.0.0.1:55514");
    expect(target.isLocal).toBe(true);
  });

  it("keeps the loopback url plain HTTP even when TLS is configured", async () => {
    // The local target always dials the daemon's plain-HTTP loopback
    // Fastify (the TLS terminator is for off-box clients only); the
    // display still reflects the configured public address.
    await writeServiceToken("hydra_token_test_tls");
    const target = await resolveLocalTarget(withTls(defaultConfig()));
    expect(target.baseUrl).toBe("http://127.0.0.1:55514");
    expect(target.wsUrl).toBe("ws://127.0.0.1:55514/acp");
  });

  it("rewrites a non-loopback configured host to 127.0.0.1 for outbound dialing", async () => {
    // Without a running daemon (no pidfile), we fall back to the
    // configured host — but wildcards / LAN addresses still get
    // rewritten so the URL is dialable. The display string preserves
    // the configured advertise-as address.
    await writeServiceToken("hydra_token_test_non_loopback");
    const cfg = defaultConfig();
    const customised: HydraConfig = {
      ...cfg,
      daemon: {
        ...cfg.daemon,
        host: "192.168.1.5",
        tls: { cert: "/dev/null/cert", key: "/dev/null/key" },
      },
    };
    const target = await resolveLocalTarget(customised);
    expect(target.display).toBe("192.168.1.5:55514");
    // Without a pidfile we surface the configured non-loopback host
    // unchanged so the autostart probe attempts the right address.
    expect(target.baseUrl).toBe("http://192.168.1.5:55514");
  });
});

describe("targetFromParsedUrl", () => {
  it("builds an https/wss target for a loopback URL (resolver swaps in plain HTTP separately)", () => {
    // targetFromParsedUrl is the pure URL→target shape builder; it
    // reports https because hydra:// is always TLS. resolveRemoteTarget
    // recognises loopback and substitutes a plain-HTTP loopback URL
    // from the daemon's pidfile — that's covered by a separate test.
    const parsed = parseHydraUrl("hydra://127.0.0.1/sess_abc");
    const target = targetFromParsedUrl(parsed, "tok123");
    expect(target.baseUrl).toBe("https://127.0.0.1:55514");
    expect(target.wsUrl).toBe("wss://127.0.0.1:55514/acp");
    expect(target.token).toBe("tok123");
    expect(target.display).toBe("127.0.0.1");
    expect(target.isLocal).toBe(true);
  });

  it("builds an https/wss target for a non-loopback host on the daemon port", () => {
    const parsed = parseHydraUrl("hydra://abc.ngrok.app/sess_abc");
    const target = targetFromParsedUrl(parsed, "tok123");
    expect(target.baseUrl).toBe("https://abc.ngrok.app:55514");
    expect(target.wsUrl).toBe("wss://abc.ngrok.app:55514/acp");
    expect(target.display).toBe("abc.ngrok.app");
    expect(target.isLocal).toBe(false);
  });

  it("uses https/wss regardless of port (hydra:// is always TLS)", () => {
    const parsed = parseHydraUrl("hydra://abc.ngrok.app:443/sess_abc");
    const target = targetFromParsedUrl(parsed, "tok123");
    expect(target.baseUrl).toBe("https://abc.ngrok.app:443");
    expect(target.wsUrl).toBe("wss://abc.ngrok.app:443/acp");
    expect(target.display).toBe("abc.ngrok.app:443");
  });

  it("includes a non-default port in display for non-loopback", () => {
    const parsed = parseHydraUrl("hydra://abc.ngrok.app:7000/sess_abc");
    const target = targetFromParsedUrl(parsed, "tok123");
    expect(target.display).toBe("abc.ngrok.app:7000");
    expect(target.baseUrl).toBe("https://abc.ngrok.app:7000");
  });
});

function futureIso(deltaMs: number): string {
  return new Date(Date.now() + deltaMs).toISOString();
}

// Default TLS handshake stub for tests that don't care about TOFU:
// reports the cert chain as already-trusted so resolveRemoteTarget
// skips the probe + prompt and goes straight to the password flow.
// Real tls.connect would hang against the fake hostnames these tests
// use ("abc.ngrok.app").
const trustedHandshake = async () =>
  ({ kind: "trusted" }) as const;

describe("resolveRemoteTarget", () => {
  it("uses the local service token for loopback when present", async () => {
    await writeServiceToken("hydra_token_local");
    const parsed = parseHydraUrl("hydra://127.0.0.1/sess_abc");
    const target = await resolveRemoteTarget(parsed, {
      fetchImpl: failOnFetch,
      promptImpl: failOnPrompt,
    });
    expect(target.token).toBe("hydra_token_local");
    expect(target.isLocal).toBe(true);
  });

  it("returns the cached token when one exists and is fresh", async () => {
    const store = await RemotesStore.load();
    await store.set("127.0.0.1", 55514, {
      token: "tok-cached",
      expiresAt: futureIso(60_000),
    });
    const parsed = parseHydraUrl("hydra://127.0.0.1/sess_abc");
    const target = await resolveRemoteTarget(parsed, {
      store,
      preferServiceToken: false,
      fetchImpl: failOnFetch,
      promptImpl: failOnPrompt,
    });
    expect(target.token).toBe("tok-cached");
  });

  it("prompts and logs in when no token is cached", async () => {
    const captured: { url?: string; body?: unknown } = {};
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      captured.url = input;
      captured.body = init?.body ? JSON.parse(String(init.body)) : undefined;
      return new Response(
        JSON.stringify({
          session_token: "tok-fresh",
          id: "sid-1",
          expires_at: futureIso(120_000),
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const promptImpl = async (_: string) => "hunter2";
    const parsed = parseHydraUrl("hydra://abc.ngrok.app/sess_abc");
    const target = await resolveRemoteTarget(parsed, {
      fetchImpl,
      promptImpl,
      tlsHandshakeImpl: trustedHandshake,
    });
    expect(captured.url).toBe("https://abc.ngrok.app:55514/v1/auth/login");
    expect((captured.body as { password: string }).password).toBe("hunter2");
    expect(target.token).toBe("tok-fresh");
    expect(target.baseUrl).toBe("https://abc.ngrok.app:55514");
  });

  it("caches the fresh token under host:port", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          session_token: "tok-fresh",
          id: "sid-1",
          expires_at: futureIso(120_000),
        }),
        { status: 200 },
      )) as typeof fetch;
    const parsed = parseHydraUrl("hydra://abc.ngrok.app/sess_abc");
    await resolveRemoteTarget(parsed, {
      fetchImpl,
      promptImpl: async () => "hunter2",
      tlsHandshakeImpl: trustedHandshake,
    });
    const reloaded = await RemotesStore.load();
    expect(reloaded.get("abc.ngrok.app", 55514)?.token).toBe("tok-fresh");
  });

  it("surfaces a friendly error on 401", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "nope" }), { status: 401 })) as typeof fetch;
    const parsed = parseHydraUrl("hydra://abc.ngrok.app/sess_abc");
    await expect(
      resolveRemoteTarget(parsed, {
        fetchImpl,
        promptImpl: async () => "wrong",
        tlsHandshakeImpl: trustedHandshake,
      }),
    ).rejects.toThrow(/Wrong password/);
  });

  it("surfaces a friendly error on 403 (no password set)", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "no pw" }), { status: 403 })) as typeof fetch;
    const parsed = parseHydraUrl("hydra://abc.ngrok.app/sess_abc");
    await expect(
      resolveRemoteTarget(parsed, {
        fetchImpl,
        promptImpl: async () => "x",
        tlsHandshakeImpl: trustedHandshake,
      }),
    ).rejects.toThrow(/No password is configured/);
  });

  it("surfaces a friendly error on 429", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "ratelimit" }), { status: 429 })) as typeof fetch;
    const parsed = parseHydraUrl("hydra://abc.ngrok.app/sess_abc");
    await expect(
      resolveRemoteTarget(parsed, {
        fetchImpl,
        promptImpl: async () => "x",
        tlsHandshakeImpl: trustedHandshake,
      }),
    ).rejects.toThrow(/Too many failed login attempts/);
  });

  it("rejects an empty password rather than calling the daemon", async () => {
    const parsed = parseHydraUrl("hydra://abc.ngrok.app/sess_abc");
    await expect(
      resolveRemoteTarget(parsed, {
        fetchImpl: failOnFetch,
        promptImpl: async () => "",
        tlsHandshakeImpl: trustedHandshake,
      }),
    ).rejects.toThrow(/Password is required/);
  });

  it("throws NoCachedCredentialError when allowPrompt is false and no token cached", async () => {
    const parsed = parseHydraUrl("hydra://abc.ngrok.app/sess_abc");
    await expect(
      resolveRemoteTarget(parsed, {
        fetchImpl: failOnFetch,
        promptImpl: failOnPrompt,
        allowPrompt: false,
      }),
    ).rejects.toBeInstanceOf(NoCachedCredentialError);
  });

  it("error message points at the interactive login command (default port)", async () => {
    const parsed = parseHydraUrl("hydra://abc.ngrok.app/sess_abc");
    // Pin argv[1] to a known value so the embedded bin-name in the
    // hint is predictable. (vitest's argv[1] points at its worker
    // bundle.) Restored after.
    const saved = process.argv[1] ?? "";
    process.argv[1] = "/usr/local/bin/hydra";
    try {
      try {
        await resolveRemoteTarget(parsed, {
          fetchImpl: failOnFetch,
          promptImpl: failOnPrompt,
          allowPrompt: false,
        });
        throw new Error("expected throw");
      } catch (err) {
        // Default port (55514) elided in the suggested command, even
        // though the diagnostic prefix still mentions it.
        expect((err as Error).message).toMatch(
          /hydra --session hydra:\/\/abc\.ngrok\.app\/[^:]/,
        );
      }
    } finally {
      process.argv[1] = saved;
    }
  });

  it("error message includes explicit non-default port", async () => {
    const parsed = parseHydraUrl("hydra://abc.ngrok.app:7000/sess_abc");
    try {
      await resolveRemoteTarget(parsed, {
        fetchImpl: failOnFetch,
        promptImpl: failOnPrompt,
        allowPrompt: false,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as Error).message).toContain(":7000");
    }
  });

  it("allowPrompt=false still uses the service-token shortcut on loopback", async () => {
    await writeServiceToken("hydra_token_local");
    const parsed = parseHydraUrl("hydra://127.0.0.1/sess_abc");
    const target = await resolveRemoteTarget(parsed, {
      fetchImpl: failOnFetch,
      promptImpl: failOnPrompt,
      allowPrompt: false,
    });
    expect(target.token).toBe("hydra_token_local");
  });

  it("allowPrompt=false still uses a cached token on remote hosts", async () => {
    const store = await RemotesStore.load();
    await store.set("abc.ngrok.app", 55514, {
      token: "tok-cached",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const parsed = parseHydraUrl("hydra://abc.ngrok.app/sess_abc");
    const target = await resolveRemoteTarget(parsed, {
      store,
      fetchImpl: failOnFetch,
      promptImpl: failOnPrompt,
      allowPrompt: false,
    });
    expect(target.token).toBe("tok-cached");
  });

  it("TOFU: prompts for trust on untrusted TLS, pins on yes, persists alongside token", async () => {
    const { _resetForTests, getPin } = await import("./tls-trust.js");
    _resetForTests();
    const stderrCaptured: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrCaptured.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );
      return true;
    }) as typeof process.stderr.write;
    try {
      const fetchImpl = (async () =>
        new Response(
          JSON.stringify({
            session_token: "tok-after-pin",
            id: "sid-1",
            expires_at: futureIso(120_000),
          }),
          { status: 200 },
        )) as typeof fetch;
      const parsed = parseHydraUrl("hydra://blackbox.local:443/sess_abc");
      const target = await resolveRemoteTarget(parsed, {
        fetchImpl,
        promptImpl: async () => "hunter2",
        confirmImpl: async () => true,
        tlsHandshakeImpl: async () => ({
          kind: "untrusted",
          fingerprint: "deadbeefcafefacefeedfacedeadbeefcafefacefeedfacedeadbeefcafeface",
          subject: "CN=blackbox.local",
          issuer: "CN=blackbox.local",
        }),
      });
      expect(target.token).toBe("tok-after-pin");
      expect(getPin("blackbox.local", 443)).toBe(
        "deadbeefcafefacefeedfacedeadbeefcafefacefeedfacedeadbeefcafeface",
      );
      const reloaded = await RemotesStore.load();
      const entry = reloaded.get("blackbox.local", 443);
      expect(entry?.pinnedFingerprint).toBe(
        "deadbeefcafefacefeedfacedeadbeefcafefacefeedfacedeadbeefcafeface",
      );
      expect(entry?.pinnedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(stderrCaptured.join("")).toMatch(/is not signed by a trusted CA/);
    } finally {
      process.stderr.write = origWrite;
    }
  });

  it("TOFU: aborts the login when the user declines to trust the cert", async () => {
    const { _resetForTests } = await import("./tls-trust.js");
    _resetForTests();
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const parsed = parseHydraUrl("hydra://blackbox.local:443/sess_abc");
      await expect(
        resolveRemoteTarget(parsed, {
          fetchImpl: failOnFetch,
          promptImpl: failOnPrompt,
          confirmImpl: async () => false,
          tlsHandshakeImpl: async () => ({
            kind: "untrusted",
            fingerprint: "ff".repeat(32),
          }),
        }),
      ).rejects.toThrow(/not trusted/);
    } finally {
      process.stderr.write = origWrite;
    }
  });

  it("TOFU: skipped when the cert chain validates against the system trust store", async () => {
    const { _resetForTests, getPin } = await import("./tls-trust.js");
    _resetForTests();
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          session_token: "tok-ca-signed",
          id: "sid-1",
          expires_at: futureIso(120_000),
        }),
        { status: 200 },
      )) as typeof fetch;
    const parsed = parseHydraUrl("hydra://abc.ngrok.app:443/sess_abc");
    const target = await resolveRemoteTarget(parsed, {
      fetchImpl,
      promptImpl: async () => "pw",
      confirmImpl: async () => {
        throw new Error("confirm should not be called when cert is trusted");
      },
      tlsHandshakeImpl: async () => ({ kind: "trusted" }),
    });
    expect(target.token).toBe("tok-ca-signed");
    expect(getPin("abc.ngrok.app", 443)).toBeUndefined();
    const reloaded = await RemotesStore.load();
    expect(reloaded.get("abc.ngrok.app", 443)?.pinnedFingerprint).toBeUndefined();
  });

  it("loopback can be forced through the password flow with preferServiceToken=false", async () => {
    await writeServiceToken("hydra_token_local");
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          session_token: "tok-password",
          id: "sid-1",
          expires_at: futureIso(120_000),
        }),
        { status: 200 },
      )) as typeof fetch;
    const parsed = parseHydraUrl("hydra://127.0.0.1/sess_abc");
    const target = await resolveRemoteTarget(parsed, {
      fetchImpl,
      promptImpl: async () => "pw",
      preferServiceToken: false,
      tlsHandshakeImpl: trustedHandshake,
    });
    expect(target.token).toBe("tok-password");
  });
});

const failOnFetch: typeof fetch = (async () => {
  throw new Error("fetch should not be called in this case");
}) as typeof fetch;

const failOnPrompt = async (): Promise<string> => {
  throw new Error("prompt should not be called in this case");
};

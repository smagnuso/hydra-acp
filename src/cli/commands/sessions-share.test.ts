import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import { runSessionsShare } from "./sessions.js";
import { writeConfig, defaultConfig, type HydraConfig } from "../../core/config.js";
import { writeServiceToken } from "../../core/service-token.js";

// Capture writes to stdout / stderr without printing them in vitest.
function captureStdio(): {
  out: () => string;
  err: () => string;
  restore: () => void;
} {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  return {
    out: () => stdoutChunks.join(""),
    err: () => stderrChunks.join(""),
    restore: () => {
      process.stdout.write = origStdout;
      process.stderr.write = origStderr;
    },
  };
}

// Tests that need to exercise the "no id supplied" branch hit the
// daemon via global fetch. We stub it and route through a per-test
// implementation. Returns a setter so each test can install its own
// response without leaking to neighbours.
function stubFetch(): { setImpl: (impl: typeof fetch) => void; restore: () => void } {
  const original = globalThis.fetch;
  let impl: typeof fetch = (async () => {
    throw new Error("fetch was called without an implementation");
  }) as typeof fetch;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    impl(input, init)) as typeof fetch;
  return {
    setImpl: (next) => {
      impl = next;
    },
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

async function configWith(overrides: Partial<HydraConfig["daemon"]> = {}): Promise<HydraConfig> {
  const cfg = defaultConfig();
  const next: HydraConfig = {
    ...cfg,
    daemon: { ...cfg.daemon, ...overrides },
  };
  await writeConfig(next);
  return next;
}

describe("runSessionsShare", () => {
  let stdio: ReturnType<typeof captureStdio>;
  let fetchStub: ReturnType<typeof stubFetch>;
  let originalExit: typeof process.exit;

  beforeEach(() => {
    stdio = captureStdio();
    fetchStub = stubFetch();
    // process.exit short-circuits await chains in tests; throw instead
    // so we can assert on it without nondeterministic timing.
    originalExit = process.exit;
    process.exit = ((code?: number): never => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as typeof process.exit;
  });

  afterEach(() => {
    stdio.restore();
    fetchStub.restore();
    process.exit = originalExit;
  });

  it("prints a loopback URL with the short session id and warns when host falls back", async () => {
    await configWith();
    await runSessionsShare("hydra_session_abcDEF1234567890");
    expect(stdio.out().trim()).toBe("hydra://127.0.0.1/abcDEF1234567890");
    expect(stdio.err()).toMatch(/loopback/);
  });

  it("strips the prefix when the user passes the wire form", async () => {
    await configWith();
    await runSessionsShare("hydra_session_xyzXYZ7890123456");
    expect(stdio.out().trim()).toBe("hydra://127.0.0.1/xyzXYZ7890123456");
  });

  it("passes the short form through unchanged", async () => {
    await configWith();
    await runSessionsShare("xyzXYZ7890123456");
    expect(stdio.out().trim()).toBe("hydra://127.0.0.1/xyzXYZ7890123456");
  });

  it("uses --host when supplied and defaults port to the daemon port (elided)", async () => {
    await configWith();
    await runSessionsShare("abc", { host: "demo.ngrok.app" });
    expect(stdio.out().trim()).toBe("hydra://demo.ngrok.app/abc");
    expect(stdio.err()).toBe("");
  });

  it("ignores daemon.port when --host is set (advertised host stands alone)", async () => {
    await configWith({ port: 8080 });
    await runSessionsShare("abc", { host: "demo.ngrok.app" });
    expect(stdio.out().trim()).toBe("hydra://demo.ngrok.app/abc");
  });

  it("renders an explicit :443 in --host (TLS-fronted tunnel)", async () => {
    await configWith();
    await runSessionsShare("abc", { host: "demo.ngrok.app:443" });
    expect(stdio.out().trim()).toBe("hydra://demo.ngrok.app:443/abc");
  });

  it("respects an explicit port suffix on --host", async () => {
    await configWith();
    await runSessionsShare("abc", { host: "demo.example.com:7000" });
    expect(stdio.out().trim()).toBe("hydra://demo.example.com:7000/abc");
  });

  it("uses daemon.publicHost when set and --host is not", async () => {
    await configWith({ publicHost: "tunnel.example.com" });
    await runSessionsShare("abc");
    expect(stdio.out().trim()).toBe("hydra://tunnel.example.com/abc");
    expect(stdio.err()).toBe("");
  });

  it("respects a port suffix in publicHost", async () => {
    await configWith({ publicHost: "tunnel.example.com:7000" });
    await runSessionsShare("abc");
    expect(stdio.out().trim()).toBe("hydra://tunnel.example.com:7000/abc");
  });

  it("prefers --host over publicHost", async () => {
    await configWith({ publicHost: "tunnel.example.com" });
    await runSessionsShare("abc", { host: "override.example.com" });
    expect(stdio.out().trim()).toBe("hydra://override.example.com/abc");
  });

  it("uses daemon.host and daemon.port for direct LAN advertising", async () => {
    await configWith({ host: "192.168.1.5" });
    await runSessionsShare("abc");
    expect(stdio.out().trim()).toBe("hydra://192.168.1.5/abc");
    expect(stdio.err()).toBe("");
  });

  it("falls back to most-recent in cwd when id is omitted", async () => {
    await configWith();
    await writeServiceToken("svc-tok");
    fetchStub.setImpl((async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      expect(url.pathname).toBe("/v1/sessions");
      expect(url.searchParams.get("all")).toBe("true");
      expect((init?.headers as Record<string, string>)["Authorization"]).toBe(
        "Bearer svc-tok",
      );
      const cwd = url.searchParams.get("cwd")!;
      return new Response(
        JSON.stringify({
          sessions: [
            {
              sessionId: "hydra_session_old0000000000000",
              cwd,
              updatedAt: "2025-01-01T00:00:00Z",
              attachedClients: 0,
              status: "cold",
            },
            {
              sessionId: "hydra_session_new1111111111111",
              cwd,
              updatedAt: "2025-02-01T00:00:00Z",
              attachedClients: 0,
              status: "cold",
            },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch);

    await runSessionsShare(undefined, { cwd: "/tmp/work" });
    expect(stdio.out().trim()).toBe("hydra://127.0.0.1/new1111111111111");
  });

  it("exits non-zero when no sessions exist for cwd", async () => {
    await configWith();
    await writeServiceToken("svc-tok");
    fetchStub.setImpl((async () =>
      new Response(JSON.stringify({ sessions: [] }), { status: 200 })) as typeof fetch);
    await expect(
      runSessionsShare(undefined, { cwd: "/tmp/empty" }),
    ).rejects.toThrow(/process\.exit\(1\)/);
    expect(stdio.err()).toMatch(/No sessions found/);
  });

  it("treats an empty id arg the same as undefined", async () => {
    await configWith();
    await writeServiceToken("svc-tok");
    fetchStub.setImpl((async () =>
      new Response(
        JSON.stringify({
          sessions: [
            {
              sessionId: "hydra_session_pickme0000000000",
              cwd: "/tmp/work",
              updatedAt: "2025-02-01T00:00:00Z",
              attachedClients: 0,
              status: "warm",
            },
          ],
        }),
        { status: 200 },
      )) as typeof fetch);
    await runSessionsShare("", { cwd: "/tmp/work" });
    expect(stdio.out().trim()).toBe("hydra://127.0.0.1/pickme0000000000");
  });
});

// Make sure the per-test config and tmp home don't leak.
afterEach(async () => {
  try {
    await fs.rm(`${process.env.HYDRA_ACP_HOME}/config.json`, { force: true });
  } catch {
    // not a test that wrote config
  }
});

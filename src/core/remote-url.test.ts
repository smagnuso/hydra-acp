import { describe, it, expect } from "vitest";
import {
  formatHydraUrl,
  isLoopbackHost,
  parseHydraUrl,
  transportFor,
} from "./remote-url.js";
import { DEFAULT_DAEMON_PORT } from "./config.js";

describe("parseHydraUrl", () => {
  it("parses loopback URL with session id and default port", () => {
    const r = parseHydraUrl("hydra://127.0.0.1/sess_abc");
    expect(r.host).toBe("127.0.0.1");
    expect(r.port).toBe(DEFAULT_DAEMON_PORT);
    expect(r.sessionId).toBe("sess_abc");
    expect(r.isLoopback).toBe(true);
  });

  it("parses localhost URL", () => {
    const r = parseHydraUrl("hydra://localhost/sess_abc");
    expect(r.host).toBe("localhost");
    expect(r.isLoopback).toBe(true);
    expect(r.port).toBe(DEFAULT_DAEMON_PORT);
  });

  it("parses URL with no session id (picker mode)", () => {
    const r = parseHydraUrl("hydra://127.0.0.1/");
    expect(r.sessionId).toBeUndefined();
  });

  it("treats missing trailing slash as no session id", () => {
    const r = parseHydraUrl("hydra://127.0.0.1");
    expect(r.sessionId).toBeUndefined();
  });

  it("uses explicit port when present", () => {
    const r = parseHydraUrl("hydra://127.0.0.1:8080/sess_abc");
    expect(r.port).toBe(8080);
  });

  it("defaults non-loopback hosts to 443", () => {
    const r = parseHydraUrl("hydra://abc.ngrok.app/sess_abc");
    expect(r.port).toBe(443);
    expect(r.isLoopback).toBe(false);
  });

  it("respects explicit port on non-loopback hosts", () => {
    const r = parseHydraUrl("hydra://abc.ngrok.app:7000/sess_abc");
    expect(r.port).toBe(7000);
  });

  it("rejects empty input", () => {
    expect(() => parseHydraUrl("")).toThrow(/hydra:/);
  });

  it("rejects non-hydra scheme", () => {
    expect(() => parseHydraUrl("http://127.0.0.1/x")).toThrow(/hydra:/);
  });

  it("rejects missing host", () => {
    expect(() => parseHydraUrl("hydra:///x")).toThrow(/host/);
  });

  it("rejects out-of-range port", () => {
    expect(() => parseHydraUrl("hydra://127.0.0.1:0/x")).toThrow(/port/);
    expect(() => parseHydraUrl("hydra://127.0.0.1:70000/x")).toThrow(/port/);
  });
});

describe("isLoopbackHost", () => {
  it("recognises loopback names", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
  });

  it("rejects non-loopback names", () => {
    expect(isLoopbackHost("1.2.3.4")).toBe(false);
    expect(isLoopbackHost("abc.ngrok.app")).toBe(false);
    expect(isLoopbackHost("")).toBe(false);
  });
});

describe("transportFor", () => {
  it("uses plain http/ws for loopback", () => {
    expect(transportFor("127.0.0.1")).toEqual({
      httpScheme: "http",
      wsScheme: "ws",
    });
  });

  it("uses https/wss for non-loopback", () => {
    expect(transportFor("abc.ngrok.app")).toEqual({
      httpScheme: "https",
      wsScheme: "wss",
    });
  });
});

describe("formatHydraUrl", () => {
  it("omits port for loopback default", () => {
    expect(
      formatHydraUrl({
        host: "127.0.0.1",
        port: DEFAULT_DAEMON_PORT,
        sessionId: "sess_abc",
      }),
    ).toBe("hydra://127.0.0.1/sess_abc");
  });

  it("omits port for https default", () => {
    expect(
      formatHydraUrl({
        host: "abc.ngrok.app",
        port: 443,
        sessionId: "sess_abc",
      }),
    ).toBe("hydra://abc.ngrok.app/sess_abc");
  });

  it("includes non-default port", () => {
    expect(
      formatHydraUrl({
        host: "127.0.0.1",
        port: 8080,
        sessionId: "sess_abc",
      }),
    ).toBe("hydra://127.0.0.1:8080/sess_abc");
  });

  it("emits trailing slash when no session id", () => {
    expect(formatHydraUrl({ host: "127.0.0.1" })).toBe("hydra://127.0.0.1/");
  });

  it("round-trips through parseHydraUrl", () => {
    const inputs = [
      "hydra://127.0.0.1/sess_abc",
      "hydra://127.0.0.1:8080/sess_abc",
      "hydra://abc.ngrok.app/sess_abc",
      "hydra://abc.ngrok.app:7000/sess_abc",
      "hydra://127.0.0.1/",
    ];
    for (const input of inputs) {
      const parsed = parseHydraUrl(input);
      const formatted = formatHydraUrl({
        host: parsed.host,
        port: parsed.port,
        sessionId: parsed.sessionId,
      });
      expect(formatted).toBe(input);
    }
  });
});

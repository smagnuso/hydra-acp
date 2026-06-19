import { describe, it, expect } from "vitest";
import { Bundle, decodeBundle, encodeBundle } from "./bundle.js";

function sampleRecord() {
  return {
    version: 1 as const,
    sessionId: "hydra_session_abc",
    lineageId: "hydra_lineage_xyz",
    upstreamSessionId: "u_anything",
    agentId: "claude-acp",
    cwd: "/work",
    title: "test session",
    currentModel: "claude-opus",
    createdAt: "2026-05-13T10:00:00.000Z",
    updatedAt: "2026-05-13T11:00:00.000Z",
    attentionFlags: [],
  };
}

describe("Bundle", () => {
  it("round-trips through encode + decode without loss of meta fields", () => {
    const encoded = encodeBundle({
      record: sampleRecord(),
      history: [
        { method: "session/update", params: { foo: 1 }, recordedAt: 100 },
      ],
      promptHistory: ["first prompt", "second prompt"],
      hydraVersion: "0.1.0",
      machine: "test-host",
    });
    const json = JSON.stringify(encoded);
    const decoded = decodeBundle(JSON.parse(json));

    expect(decoded.version).toBe(1);
    expect(decoded.session.sessionId).toBe("hydra_session_abc");
    expect(decoded.session.lineageId).toBe("hydra_lineage_xyz");
    expect(decoded.session.upstreamSessionId).toBe("u_anything");
    expect(decoded.session.agentId).toBe("claude-acp");
    expect(decoded.session.title).toBe("test session");
    expect(decoded.session.currentModel).toBe("claude-opus");
    expect(decoded.history).toHaveLength(1);
    expect(decoded.history[0]?.method).toBe("session/update");
    expect(decoded.promptHistory).toEqual(["first prompt", "second prompt"]);
    expect(decoded.exportedFrom.hydraVersion).toBe("0.1.0");
    expect(decoded.exportedFrom.machine).toBe("test-host");
  });

  it("carries raw interactive + originatingClient when set, omits when absent", () => {
    const withFlags = encodeBundle({
      record: {
        ...sampleRecord(),
        interactive: true,
        originatingClient: { name: "hydra-acp-cat", version: "9.9.9" },
      },
      history: [],
      hydraVersion: "0.1.0",
      machine: "h",
    });
    const decoded = decodeBundle(JSON.parse(JSON.stringify(withFlags)));
    expect(decoded.session.interactive).toBe(true);
    expect(decoded.session.originatingClient).toEqual({
      name: "hydra-acp-cat",
      version: "9.9.9",
    });

    // Undecided source (interactive undefined) must NOT serialize a value
    // — that's what keeps an imported cat/empty session promotable.
    const withoutFlags = encodeBundle({
      record: sampleRecord(),
      history: [],
      hydraVersion: "0.1.0",
      machine: "h",
    });
    expect("interactive" in withoutFlags.session).toBe(false);
    expect("originatingClient" in withoutFlags.session).toBe(false);
  });

  it("carries upstreamSessionId when the source record has one", () => {
    const encoded = encodeBundle({
      record: { ...sampleRecord(), upstreamSessionId: "agent-side-id-123" },
      history: [],
      hydraVersion: "0.1.0",
      machine: "h",
    });
    expect(encoded.session.upstreamSessionId).toBe("agent-side-id-123");
    const decoded = decodeBundle(encoded);
    expect(decoded.session.upstreamSessionId).toBe("agent-side-id-123");
  });

  it("omits upstreamSessionId when the source record's upstream is empty", () => {
    const encoded = encodeBundle({
      record: { ...sampleRecord(), upstreamSessionId: "" },
      history: [],
      hydraVersion: "0.1.0",
      machine: "h",
    });
    expect("upstreamSessionId" in encoded.session).toBe(false);
  });

  it("rejects a bundle that lacks a lineageId", () => {
    expect(() =>
      decodeBundle({
        version: 1,
        exportedAt: "2026-05-13T...",
        exportedFrom: { hydraVersion: "0.1.0", machine: "h" },
        session: {
          sessionId: "hydra_session_abc",
          // lineageId intentionally omitted
          agentId: "claude-acp",
          cwd: "/work",
          createdAt: "2026-05-13T10:00:00.000Z",
          updatedAt: "2026-05-13T11:00:00.000Z",
        },
        history: [],
      }),
    ).toThrow();
  });

  it("rejects a bundle with an unsupported version", () => {
    const ok = encodeBundle({
      record: sampleRecord(),
      history: [],
      hydraVersion: "0.1.0",
      machine: "h",
    });
    const broken = { ...ok, version: 2 };
    expect(() => decodeBundle(broken)).toThrow();
  });

  it("carries hydraHost when set, omits the field otherwise", () => {
    const with_host = encodeBundle({
      record: sampleRecord(),
      history: [],
      hydraVersion: "0.1.0",
      machine: "h",
      hydraHost: "samm.tailnet.example:443",
    });
    expect(with_host.exportedFrom.hydraHost).toBe("samm.tailnet.example:443");
    expect(decodeBundle(with_host).exportedFrom.hydraHost).toBe(
      "samm.tailnet.example:443",
    );

    const without = encodeBundle({
      record: sampleRecord(),
      history: [],
      hydraVersion: "0.1.0",
      machine: "h",
    });
    expect("hydraHost" in without.exportedFrom).toBe(false);

    const empty = encodeBundle({
      record: sampleRecord(),
      history: [],
      hydraVersion: "0.1.0",
      machine: "h",
      hydraHost: "",
    });
    expect("hydraHost" in empty.exportedFrom).toBe(false);
  });

  it("treats promptHistory as optional", () => {
    const encoded = encodeBundle({
      record: sampleRecord(),
      history: [],
      hydraVersion: "0.1.0",
      machine: "h",
    });
    expect(encoded.promptHistory).toBeUndefined();
    const decoded = decodeBundle(encoded);
    expect(decoded.promptHistory).toBeUndefined();
  });

  it("validates a known-good bundle through the exported Bundle schema directly", () => {
    const encoded = encodeBundle({
      record: sampleRecord(),
      history: [],
      hydraVersion: "0.1.0",
      machine: "h",
    });
    expect(() => Bundle.parse(encoded)).not.toThrow();
  });
});

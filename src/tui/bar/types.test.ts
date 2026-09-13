import { describe, it, expect } from "vitest";
import { foreignCwdOwner, isRemoteSession } from "./types.js";

describe("foreignCwdOwner", () => {
  it("returns undefined for a plain local session", () => {
    expect(foreignCwdOwner({})).toBeUndefined();
    expect(foreignCwdOwner(undefined)).toBeUndefined();
  });

  it("returns the peer name for a live federated session", () => {
    expect(foreignCwdOwner({ remote: "workbox" })).toBe("workbox");
  });

  it("returns the origin machine for a dormant import (never forked locally)", () => {
    expect(
      foreignCwdOwner({ importedFromMachine: "old-laptop" }),
    ).toBe("old-laptop");
  });

  it("returns undefined once a dormant import has been forked locally", () => {
    // upstreamSessionId set means promptForImportCwd already ran and
    // chose a real local cwd — the record is genuinely local from here.
    expect(
      foreignCwdOwner({
        importedFromMachine: "old-laptop",
        upstreamSessionId: "up_1",
      }),
    ).toBeUndefined();
  });

  it("prefers remote over importedFromMachine when both are set", () => {
    expect(
      foreignCwdOwner({ remote: "workbox", importedFromMachine: "old-laptop" }),
    ).toBe("workbox");
  });
});

describe("isRemoteSession", () => {
  it("is false when remote is unset", () => {
    expect(isRemoteSession({})).toBe(false);
  });

  it("is true when remote is set", () => {
    expect(isRemoteSession({ remote: "workbox" })).toBe(true);
  });
});

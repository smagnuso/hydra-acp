import { describe, it, expect } from "vitest";
import { FIELDS } from "./fields.js";
import * as os from "node:os";
import * as path from "node:path";
import type { FieldContext } from "./types.js";

// Under the real home, so shortenHomePath actually abbreviates — it is a
// no-op on paths outside it, which would silently defeat the display
// assertions below.
const SRC = path.join(os.homedir(), "proj");
const WS = path.join(os.homedir(), ".hydra-acp/workspaces/ab12/feature-x");

function ctx(session: Partial<FieldContext["session"]>): FieldContext {
  return {
    scope: "sessionbar",
    session: {
      agent: "claude-code",
      cwd: SRC,
      sessionId: "hydra_session_abc",
      ...session,
    },
    banner: { queued: 0, status: "ready", elapsedMs: undefined },
  } as unknown as FieldContext;
}

describe("cwd bar field", () => {
  it("shows one openable span for an ordinary session", () => {
    const out = FIELDS.cwd!.resolve(ctx({ cwd: SRC }))!;
    expect(out).toHaveLength(1);
    expect(out[0]?.text).toBe("~/proj");
    // The double-click value is the ABSOLUTE path, not the ~-abbreviated
    // display form.
    expect(out[0]?.value).toBe(SRC);
  });

  it("splits into project and workspace spans while isolated", () => {
    const out = FIELDS.cwd!.resolve(
      ctx({ cwd: WS, workspace: { label: "feature-x", path: WS, sourceCwd: SRC } }),
    )!;
    expect(out).toHaveLength(2);
    // Each span opens what its text names, so neither has to lie about
    // where a double-click goes.
    expect(out[0]?.text).toBe("~/proj");
    expect(out[0]?.value).toBe(SRC);
    expect(out[1]?.text).toBe(" [feature-x]");
    expect(out[1]?.value).toBe(WS);
  });

  it("never hands a formatted display string to the open action", () => {
    // Regression. The label used to be baked into `cwd` upstream, so the
    // double-click tried to open "~/proj [feature-x]" as a directory.
    const out = FIELDS.cwd!.resolve(
      ctx({ cwd: WS, workspace: { label: "feature-x", path: WS, sourceCwd: SRC } }),
    )!;
    for (const span of out) {
      expect(span.value).not.toMatch(/[[\]]/);
      expect(span.value?.startsWith("/")).toBe(true);
    }
  });

  it("shows the hash directory only when it is genuinely the cwd", () => {
    // No workspace state: fall back to rendering cwd verbatim rather than
    // inventing a project name.
    const out = FIELDS.cwd!.resolve(ctx({ cwd: WS }))!;
    expect(out).toHaveLength(1);
    expect(out[0]?.value).toBe(WS);
  });
});

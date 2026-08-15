import { describe, it, expect } from "vitest";
import { FIELDS } from "./fields.js";
import { layoutRow, type FieldGroup } from "./layout.js";
import { SLOT_STYLES, resolveSide } from "./slots.js";
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

function groups(session: Partial<FieldContext["session"]>): FieldGroup[] {
  return FIELDS.cwd!.resolveGroups!(ctx(session))!;
}

const isolated = {
  cwd: WS,
  workspace: { label: "feature-x", path: WS, sourceCwd: SRC },
};

describe("cwd bar field", () => {
  it("shows one openable span for an ordinary session", () => {
    const out = groups({ cwd: SRC });
    expect(out).toHaveLength(1);
    expect(out[0]?.chunks[0]?.text).toBe("~/proj");
    // The double-click value is the ABSOLUTE path, not the ~-abbreviated
    // display form.
    expect(out[0]?.chunks[0]?.value).toBe(SRC);
  });

  it("splits into project and workspace groups while isolated", () => {
    const out = groups(isolated);
    expect(out.map((g) => g.id)).toEqual(["cwd", "cwdWorkspace"]);
    // Each span opens what its text names, so neither has to lie about
    // where a double-click goes.
    expect(out[0]?.chunks[0]?.text).toBe("~/proj");
    expect(out[0]?.chunks[0]?.value).toBe(SRC);
    expect(out[1]?.chunks[0]?.text).toBe("[feature-x]");
    expect(out[1]?.chunks[0]?.value).toBe(WS);
  });

  it("joins the label with a space, not the slot separator", () => {
    // " · " between them would read as two unrelated fields.
    expect(groups(isolated)[1]?.separator).toBe(" ");
  });

  it("never hands a formatted display string to the open action", () => {
    // Regression. The label used to be baked into `cwd` upstream, so the
    // double-click tried to open "~/proj [feature-x]" as a directory.
    for (const g of groups(isolated)) {
      for (const chunk of g.chunks) {
        expect(chunk.value).not.toMatch(/[[\]]/);
        expect(chunk.value?.startsWith("/")).toBe(true);
      }
    }
  });

  it("shows the hash directory only when it is genuinely the cwd", () => {
    // No workspace state: fall back to rendering cwd verbatim rather than
    // inventing a project name.
    const out = groups({ cwd: WS });
    expect(out).toHaveLength(1);
    expect(out[0]?.chunks[0]?.value).toBe(WS);
  });

  it("gives the path and the label separate hit regions", () => {
    // Regression. As runs of a single field they shared one id, and the
    // layout engine merges same-id regions — so double-clicking the
    // label opened the project instead of the workspace.
    const style = SLOT_STYLES.sessionbar;
    const left = resolveSide("sessionbar", [{ field: "cwd" }], ctx(isolated));
    const { hits } = layoutRow(80, left, [], style);
    const project = hits.find((h) => h.id === "sessionbar:cwd");
    const label = hits.find((h) => h.id === "sessionbar:cwdWorkspace");
    expect(project?.value).toBe(SRC);
    expect(label?.value).toBe(WS);
    expect(project?.doubleAction).toBe("open");
    expect(label?.doubleAction).toBe("open");
    // Disjoint, and the label sits to the right of the project.
    expect(project!.end).toBeLessThan(label!.start);
  });

  it("still honours per-entry overrides now that it emits groups", () => {
    // Regression. The group path used to skip style/width/prefix
    // handling, so a configured `{ field: "cwd", prefix: … }` silently
    // stopped doing anything.
    const left = resolveSide(
      "sessionbar",
      [{ field: "cwd", prefix: "(", suffix: ")", style: "rule-meta" }],
      ctx(isolated),
    );
    const text = left.flatMap((g) => g.chunks.map((c) => c.text)).join("");
    // Brackets wrap the field as a whole, not each group.
    expect(text).toBe("(~/proj[feature-x])");
    for (const g of left) {
      for (const c of g.chunks) {
        expect(c.token).toBe("rule-meta");
      }
    }
  });

  it("sheds the label before the project when the bar is narrow", () => {
    const style = SLOT_STYLES.sessionbar;
    const left = resolveSide("sessionbar", [{ field: "cwd" }], ctx(isolated));
    const { hits } = layoutRow(10, left, [], style);
    expect(hits.map((h) => h.id)).toEqual(["sessionbar:cwd"]);
  });
});

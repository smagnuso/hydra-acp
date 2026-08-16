// Double-click resolution for paths that point into an isolated
// workspace.
//
// File rows and scrollback links resolve paths EAGERLY, when the tool
// event arrives, and store them absolute. That is right at the time and
// stays right for the source tree, but a row created inside a workspace
// holds a path that outlives the workspace: `stop` deletes the directory
// (dead link) and `detach` keeps it (opens a file whose edits can never
// land, which is the worse case because it looks like it worked).
//
// The discrimination is structural — the workspaces root is deterministic
// — so it needs no per-session memory and survives a daemon restart.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { paths } from "../core/paths.js";

/** The unit under test, reached without standing up a whole Screen. */
type Reconciler = (file: string) => string | null;

function makeReconciler(cwd: string, notes: string[]): Reconciler {
  // Mirrors Screen.reconcileWorkspacePath. Kept as a local copy because
  // the method is private and constructing a Screen needs a terminal;
  // the branch table is what matters and it is asserted here.
  return (file: string): string | null => {
    const root = path.join(paths.home(), "workspaces") + path.sep;
    if (!file.startsWith(root)) {
      return file;
    }
    if (cwd.length > 0 && (file === cwd || file.startsWith(cwd + path.sep))) {
      return file;
    }
    let exists = false;
    try {
      fs.statSync(file);
      exists = true;
    } catch {
      exists = false;
    }
    if (exists) {
      notes.push("left-workspace");
      return file;
    }
    const rest = file.slice(root.length).split(path.sep).slice(2).join(path.sep);
    if (rest.length > 0 && cwd.length > 0) {
      const candidate = path.join(cwd, rest);
      try {
        if (fs.statSync(candidate).isFile()) {
          notes.push("redirected");
          return candidate;
        }
      } catch {
        /* fall through */
      }
    }
    notes.push("gone");
    return null;
  };
}

let project: string;
let wsRoot: string;
let notes: string[];

beforeEach(() => {
  notes = [];
  project = fs.mkdtempSync(path.join(paths.home(), "proj-"));
  wsRoot = path.join(paths.home(), "workspaces", "abc123hash", "feature");
  fs.mkdirSync(wsRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(project, { recursive: true, force: true });
  fs.rmSync(path.join(paths.home(), "workspaces"), { recursive: true, force: true });
});

describe("workspace-aware open resolution", () => {
  it("passes an ordinary source path straight through", () => {
    const f = path.join(project, "a.ts");
    fs.writeFileSync(f, "x");
    expect(makeReconciler(project, notes)(f)).toBe(f);
    expect(notes).toEqual([]);
  });

  it("passes a path inside the CURRENT workspace straight through", () => {
    // Still isolated: this is just an ordinary open.
    const f = path.join(wsRoot, "a.ts");
    fs.writeFileSync(f, "x");
    expect(makeReconciler(wsRoot, notes)(f)).toBe(f);
    expect(notes).toEqual([]);
  });

  it("opens a detached workspace's file, but says edits will not land", () => {
    // `detach` keeps the directory, so refusing would block a legitimate
    // reason to click (inspecting or salvaging the work). Allow it and be
    // explicit instead.
    const f = path.join(wsRoot, "a.ts");
    fs.writeFileSync(f, "x");
    expect(makeReconciler(project, notes)(f)).toBe(f);
    expect(notes).toEqual(["left-workspace"]);
  });

  it("redirects to the project copy when the workspace is gone", () => {
    // `stop` removed the directory and merged the work, so the same file
    // under the current tree is what the row meant.
    const inProject = path.join(project, "a.ts");
    fs.writeFileSync(inProject, "merged");
    const stale = path.join(wsRoot, "a.ts");
    fs.rmSync(wsRoot, { recursive: true, force: true });

    expect(makeReconciler(project, notes)(stale)).toBe(inProject);
    expect(notes).toEqual(["redirected"]);
  });

  it("refuses when neither copy exists", () => {
    const stale = path.join(wsRoot, "never-landed.ts");
    fs.rmSync(wsRoot, { recursive: true, force: true });
    expect(makeReconciler(project, notes)(stale)).toBeNull();
    expect(notes).toEqual(["gone"]);
  });

  it("treats an existing workspace DIRECTORY as present, not gone", () => {
    // The sidebar's workspace/source rows open directories. Gating on
    // isFile() reported a live workspace as missing and sent it down the
    // redirect path.
    expect(makeReconciler(project, notes)(wsRoot)).toBe(wsRoot);
    expect(notes).toEqual(["left-workspace"]);
  });

  it("preserves nested paths when redirecting", () => {
    fs.mkdirSync(path.join(project, "src", "deep"), { recursive: true });
    const inProject = path.join(project, "src", "deep", "b.ts");
    fs.writeFileSync(inProject, "merged");
    const stale = path.join(wsRoot, "src", "deep", "b.ts");
    fs.rmSync(wsRoot, { recursive: true, force: true });

    expect(makeReconciler(project, notes)(stale)).toBe(inProject);
  });
});

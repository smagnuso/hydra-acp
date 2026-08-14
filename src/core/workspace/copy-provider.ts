// Isolation with no version control: a workspace is a copied directory.
//
// This provider exists for two reasons. It makes isolation available on a
// directory that is not a repository at all, which is the one place the
// git provider can offer nothing. And it keeps the IsolationProvider
// contract honest: if a provider with no commits, no branches, and no
// history can implement the interface without contorting itself, the
// abstraction is real rather than git wearing a different hat.
//
// It is deliberately the expensive option and says so: capabilities()
// reports cheapWorkspaces: false, which is how a caller learns to reduce
// fan-out rather than issuing a full directory copy per parallel agent.
//
// "Clean or dirty" has no VCS to answer it here, so creation writes a
// manifest sidecar (relative path to size and mtime) and status() diffs
// the tree against it. Without that, status() would have to lie, and
// reconciliation depends on it to distinguish a workspace that is safe to
// prune from one holding the only copy of somebody's work.

import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as path from "node:path";
import { readJsonSafe, writeJsonAtomic } from "../json-store.js";
import {
  WorkspaceUnsupportedError,
  sanitizeLabel,
  workspaceRootFor,
  type Capabilities,
  type CreateWorkspaceOptions,
  type CreateWorkspaceResult,
  type IntegrateResult,
  type IsolationProvider,
  type PathChange,
  type SnapshotId,
  type Workspace,
  type WorkspaceStatus,
} from "./provider.js";

export const COPY_PROVIDER_KIND = "copy";

// Skipped when copying. A copied .git would present as a repository that
// is silently detached from the original, so git tooling inside the
// workspace would report confident nonsense. Everything else comes along,
// including ignored files, which is what makes a copied workspace
// runnable with no setup step.
const SKIP_TOP_LEVEL = new Set([".git"]);

interface ManifestEntry {
  size: number;
  mtimeMs: number;
}

interface Manifest {
  sourceCwd: string;
  label: string;
  createdAt: string;
  entries: Record<string, ManifestEntry>;
}

function manifestPathFor(workspacePath: string): string {
  return `${workspacePath}.manifest.json`;
}

async function walk(root: string): Promise<Map<string, ManifestEntry>> {
  const out = new Map<string, ManifestEntry>();
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) {
      break;
    }
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (dir === root && SKIP_TOP_LEVEL.has(entry.name)) {
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      try {
        const st = await fs.stat(abs);
        out.set(path.relative(root, abs), { size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        continue;
      }
    }
  }
  return out;
}

export class CopyProvider implements IsolationProvider {
  readonly kind = COPY_PROVIDER_KIND;

  capabilities(): Capabilities {
    return {
      // A full directory copy per workspace. Callers should cap fan-out.
      cheapWorkspaces: false,
      // Nothing is recorded anywhere shared; each copy is an island.
      sharedHistory: false,
      // Reading the source to copy it never modifies it.
      nonMutatingCapture: true,
      conflictReporting: false,
      locking: false,
      requiresServer: false,
      supports: {
        record: false,
        integrate: false,
        captureWorkingState: false,
        changedPaths: false,
        environmentNotes: true,
        // Nothing is retained outside the directory itself, so once it is
        // deleted there is nothing to rebuild from. A session isolated
        // this way must fall back to a fresh workspace from its source.
        rematerialize: false,
      },
    };
  }

  async rematerialize(ws: Workspace): Promise<CreateWorkspaceResult> {
    return {
      ok: false,
      reason: `copy provider retains nothing outside ${ws.path}; it cannot be rebuilt`,
    };
  }

  async createWorkspace(opts: CreateWorkspaceOptions): Promise<CreateWorkspaceResult> {
    if (opts.from !== undefined) {
      return {
        ok: false,
        reason: "copy provider cannot create from a snapshot; it records none",
      };
    }
    const source = path.resolve(opts.sourceCwd);
    try {
      const st = await fs.stat(source);
      if (!st.isDirectory()) {
        return { ok: false, reason: `${source} is not a directory` };
      }
    } catch {
      return { ok: false, reason: `${source} does not exist` };
    }

    const root = workspaceRootFor(source);
    const label = sanitizeLabel(opts.label);
    const target = path.join(root, label);

    try {
      await fs.mkdir(root, { recursive: true });
    } catch (err) {
      return { ok: false, reason: `could not create workspace root: ${String(err)}` };
    }

    // Refuse rather than merge into an existing directory: silently
    // copying over someone else's workspace is the failure this whole
    // feature exists to prevent.
    try {
      await fs.access(target);
      return { ok: false, reason: `workspace already exists at ${target}` };
    } catch {
      // Expected: the target should not exist yet.
    }

    try {
      await fs.cp(source, target, {
        recursive: true,
        errorOnExist: false,
        force: true,
        filter: (src) => {
          const rel = path.relative(source, src);
          if (rel.length === 0) {
            return true;
          }
          const top = rel.split(path.sep)[0];
          return top === undefined || !SKIP_TOP_LEVEL.has(top);
        },
      });
    } catch (err) {
      await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
      return { ok: false, reason: `copy failed: ${String(err)}` };
    }

    const entries = await walk(target);
    const manifest: Manifest = {
      sourceCwd: source,
      label,
      createdAt: new Date().toISOString(),
      entries: Object.fromEntries(entries),
    };
    await writeJsonAtomic(manifestPathFor(target), manifest, { pretty: false });

    return {
      ok: true,
      workspace: {
        path: target,
        sourceCwd: source,
        label,
        provider: this.kind,
      },
    };
  }

  async removeWorkspace(ws: Workspace, opts: { force: boolean }): Promise<void> {
    if (!opts.force) {
      const st = await this.status(ws);
      if (!st.clean) {
        throw new Error(
          `workspace ${ws.path} has ${st.changedPaths.length} changed path(s); pass force to remove`,
        );
      }
    }
    await fs.rm(ws.path, { recursive: true, force: true });
    await fs.rm(manifestPathFor(ws.path), { force: true });
  }

  async listWorkspaces(sourceCwd: string): Promise<readonly Workspace[]> {
    const root = workspaceRootFor(path.resolve(sourceCwd));
    let names: string[];
    try {
      names = await fs.readdir(root);
    } catch {
      return [];
    }
    const out: Workspace[] = [];
    for (const name of names) {
      if (name.endsWith(".manifest.json")) {
        continue;
      }
      const target = path.join(root, name);
      const manifest = await readJsonSafe<Manifest>(manifestPathFor(target));
      if (manifest === undefined) {
        continue;
      }
      out.push({
        path: target,
        sourceCwd: manifest.sourceCwd,
        label: manifest.label,
        provider: this.kind,
      });
    }
    return out;
  }

  async status(ws: Workspace): Promise<WorkspaceStatus> {
    const manifest = await readJsonSafe<Manifest>(manifestPathFor(ws.path));
    const current = await walk(ws.path);
    if (manifest === undefined) {
      // No baseline to compare against. Report dirty: treating an
      // unknown workspace as clean would let reconciliation delete it.
      return {
        clean: false,
        changedPaths: [...current.keys()].sort(),
        hasRecordedWork: false,
      };
    }
    const changed: string[] = [];
    for (const [rel, now] of current) {
      const before = manifest.entries[rel];
      if (before === undefined || before.size !== now.size || before.mtimeMs !== now.mtimeMs) {
        changed.push(rel);
      }
    }
    for (const rel of Object.keys(manifest.entries)) {
      if (!current.has(rel)) {
        changed.push(rel);
      }
    }
    changed.sort();
    return { clean: changed.length === 0, changedPaths: changed, hasRecordedWork: false };
  }

  async environmentNotes(ws: Workspace): Promise<readonly string[]> {
    return [
      `This directory is an isolated copy of ${ws.sourceCwd}. It is not under version control: there is no history, no branches, and version-control commands will not behave as they would in the original.`,
      "Changes here are not automatically returned to the original directory.",
    ];
  }

  // `async` is deliberate: see the matching note in git-provider.ts. A
  // synchronous throw from a Promise-returning method escapes .catch().
  async captureWorkingState(): Promise<SnapshotId> {
    throw new WorkspaceUnsupportedError(this.kind, "captureWorkingState");
  }

  async record(): Promise<SnapshotId> {
    throw new WorkspaceUnsupportedError(this.kind, "record");
  }

  async changedPaths(): Promise<readonly PathChange[]> {
    throw new WorkspaceUnsupportedError(this.kind, "changedPaths");
  }

  async integrate(): Promise<IntegrateResult> {
    throw new WorkspaceUnsupportedError(this.kind, "integrate");
  }

  async lock(): Promise<void> {
    throw new WorkspaceUnsupportedError(this.kind, "lock");
  }

  async unlock(): Promise<void> {
    throw new WorkspaceUnsupportedError(this.kind, "unlock");
  }
}

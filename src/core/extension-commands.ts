import type { JsonRpcConnection } from "../acp/connection.js";

// Schema for one verb advertised by an extension or transformer through
// hydra-acp/register_commands. The verb is the second token in
// "/hydra <name> <verb>"; description and argsHint surface in completions.
export interface ExtensionCommandSpec {
  verb: string;
  argsHint?: string;
  description?: string;
}

interface Entry {
  connection: JsonRpcConnection;
  commands: ExtensionCommandSpec[];
}

// Bag of process-name → registered command list. Populated when an
// extension/transformer calls hydra-acp/register_commands; the entry
// drops on disconnect (the WS handler clears it via clear(name)).
//
// Used by:
//   - Session.handleSlashCommand to dispatch "/hydra <name> <verb>"
//   - Session.mergedAvailableCommands to surface entries to clients
export class ExtensionCommandRegistry {
  private entries = new Map<string, Entry>();
  private changeHandlers: Array<() => void> = [];

  register(
    name: string,
    connection: JsonRpcConnection,
    commands: ExtensionCommandSpec[],
  ): void {
    this.entries.set(name, { connection, commands: [...commands] });
    this.fireChanged();
  }

  clear(name: string): void {
    if (this.entries.delete(name)) {
      this.fireChanged();
    }
  }

  get(name: string): Entry | undefined {
    return this.entries.get(name);
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  // Snapshot of every (name, command) pair. Order is stable per-name
  // (insertion order of the map and the original commands list).
  list(): Array<{ name: string; command: ExtensionCommandSpec }> {
    const out: Array<{ name: string; command: ExtensionCommandSpec }> = [];
    for (const [name, entry] of this.entries) {
      for (const command of entry.commands) {
        out.push({ name, command });
      }
    }
    return out;
  }

  onChange(handler: () => void): () => void {
    this.changeHandlers.push(handler);
    return () => {
      const i = this.changeHandlers.indexOf(handler);
      if (i >= 0) {
        this.changeHandlers.splice(i, 1);
      }
    };
  }

  private fireChanged(): void {
    for (const h of this.changeHandlers) {
      try {
        h();
      } catch {
        void 0;
      }
    }
  }
}

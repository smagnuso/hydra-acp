// Tab completion for path and "@" tokens in a prompt composer, shared by
// the live session composer and the session picker's new-prompt composer.
// The completer owns the token handling and the Tab-cycle state; the host
// supplies buffer access and where to show the candidate list, since the
// two composers render differently.

import {
  completePathToken,
  extractPathToken,
  type PathCompletion,
} from "./file-completion.js";
import { completeAtMention, type MentionCompletion } from "./file-search.js";
import {
  advanceCycle,
  cycleListing,
  startCycle,
  type TabCycle,
} from "./tab-cycle.js";

export interface ListingItem {
  name: string;
  selected?: boolean;
}

export interface TabCompleterHost {
  cwd(): string;
  // True when cwd names a directory on another machine; completion stays off.
  isRemote?(): boolean;
  state(): { buffer: string[]; row: number; col: number };
  replaceRange(start: number, end: number, text: string): void;
  // The candidate list to show; empty clears it.
  showListing(items: ListingItem[]): void;
  // A file committed from an "@" mention, as (inserted token, cwd-relative path).
  recordMention?(token: string, file: string): void;
}

export interface TabCompleterDeps {
  completeMention: (token: string, cwd: string) => MentionCompletion | null;
  completePath: (token: string, cwd: string) => PathCompletion | null;
}

export interface TabCompleter {
  // Handle Tab. False leaves the key to its usual meaning (indent).
  tab(): boolean;
  // Up/Down while cycling. False when no cycle is active.
  step(delta: number): boolean;
  // Escape/^C while cycling: restore what was typed. False when idle.
  cancel(): boolean;
  // Enter while cycling: keep the candidate, do not submit. False when idle.
  accept(): boolean;
  // Any other key: the cycle ends and the list clears.
  reset(): void;
  active(): boolean;
}

export function createTabCompleter(
  host: TabCompleterHost,
  deps: TabCompleterDeps = {
    completeMention: completeAtMention,
    completePath: completePathToken,
  },
): TabCompleter {
  let cycle: TabCycle | null = null;

  const currentToken = (): { token: string; start: number; col: number; row: number } | null => {
    const st = host.state();
    const tok = extractPathToken(st.buffer[st.row] ?? "", st.col);
    return tok === null ? null : { ...tok, col: st.col, row: st.row };
  };

  const show = (c: TabCycle, tok: { start: number; col: number }): void => {
    const choice = c.choices[c.index]!;
    const cand = c.names[c.index]!;
    if (c.mention && !cand.endsWith("/")) {
      host.recordMention?.(choice, cand);
    }
    host.replaceRange(tok.start, tok.col, choice);
    host.showListing(cycleListing(c));
  };

  const tab = (): boolean => {
    if (host.isRemote?.() === true) {
      return false;
    }
    const tok = currentToken();
    if (tok === null) {
      return false;
    }
    if (cycle !== null) {
      const next = advanceCycle(cycle, tok.token, tok.row, tok.start);
      if (next !== null) {
        cycle = next;
        show(next, tok);
        return true;
      }
      cycle = null;
    }
    const cwd = host.cwd();
    const mention = deps.completeMention(tok.token, cwd);
    if (mention?.file !== undefined) {
      host.recordMention?.(mention.replacement, mention.file);
    }
    const result = mention ?? deps.completePath(tok.token, cwd);
    if (result === null) {
      return false;
    }
    // Nothing left to extend and several candidates: start cycling.
    if (result.replacement === tok.token && result.choices.length > 1) {
      cycle = startCycle(
        tok.row,
        tok.start,
        result.choices,
        result.candidates,
        mention !== null,
        tok.token,
      );
      show(cycle, tok);
      return true;
    }
    if (result.replacement !== tok.token) {
      host.replaceRange(tok.start, tok.col, result.replacement);
    }
    host.showListing(
      result.candidates.length > 1 ? result.candidates.map((name) => ({ name })) : [],
    );
    return true;
  };

  const step = (delta: number): boolean => {
    if (cycle === null) {
      return false;
    }
    const tok = currentToken();
    const next =
      tok === null ? null : advanceCycle(cycle, tok.token, tok.row, tok.start, delta);
    if (tok === null || next === null) {
      cycle = null;
      return false;
    }
    cycle = next;
    show(next, tok);
    return true;
  };

  const cancel = (): boolean => {
    if (cycle === null) {
      return false;
    }
    const c = cycle;
    cycle = null;
    host.showListing([]);
    const tok = currentToken();
    if (tok !== null && tok.token === c.choices[c.index]) {
      host.replaceRange(tok.start, tok.col, c.original);
    }
    return true;
  };

  const accept = (): boolean => {
    if (cycle === null) {
      return false;
    }
    cycle = null;
    host.showListing([]);
    return true;
  };

  return {
    tab,
    step,
    cancel,
    accept,
    reset: () => {
      cycle = null;
      host.showListing([]);
    },
    active: () => cycle !== null,
  };
}

// Pre-screen interactive picker. Lists every session (live first, then
// cold sorted by recency) with a "+ New session" entry at the top — the
// default cursor position — so Enter creates a new session or the user
// can arrow down into the list. Long lists scroll within a fixed
// viewport so every session remains reachable. Lives outside the main
// screen so it can run before fullscreen mode is engaged.

import type { Terminal } from "terminal-kit";
import { stripHydraSessionPrefix } from "../core/session.js";
import type { DiscoveredSession } from "./discovery.js";

export type PickerResult =
  | { kind: "attach"; sessionId: string; agentId?: string }
  | { kind: "new" }
  | { kind: "abort" };

export interface PickOptions {
  cwd: string;
  sessions: DiscoveredSession[];
}

interface Row {
  session: string;
  upstream: string;
  status: string;
  clients: string;
  agent: string;
  title: string;
  cwd: string;
}

interface Widths {
  session: number;
  upstream: number;
  status: number;
  clients: number;
  agent: number;
  title: number;
}

const HEADER: Row = {
  session: "SESSION",
  upstream: "UPSTREAM",
  status: "STATUS",
  clients: "CLIENTS",
  agent: "AGENT",
  title: "TITLE",
  cwd: "CWD",
};

export async function pickSession(
  term: Terminal,
  opts: PickOptions,
): Promise<PickerResult> {
  if (opts.sessions.length === 0) {
    return { kind: "new" };
  }
  // Tier sessions so live ones come first, and within the live group prefer
  // sessions whose cwd matches the caller's. This puts the most relevant
  // session at the top of the list, just below the "+ New session" entry.
  const score = (s: DiscoveredSession): number => {
    if (s.status !== "live") {
      return 0;
    }
    return s.cwd === opts.cwd ? 2 : 1;
  };
  const sorted = [...opts.sessions].sort((a, b) => {
    const tier = score(b) - score(a);
    if (tier !== 0) {
      return tier;
    }
    return b.updatedAt.localeCompare(a.updatedAt);
  });
  const visible = sorted;
  const rows = visible.map(toRow);
  const widths = computeWidths(rows);
  const newSessionLabel = `+ New session in ${opts.cwd}`;
  const headerLine = formatRow(HEADER, widths);
  const sessionLines = rows.map((r) => formatRow(r, widths));

  // Viewport sizing: "+ New" + blank + header + session viewport + scroll
  // indicator + 1 row breathing room at top = (terminal height - 6) session
  // rows. Floor at 3 so very small terminals still show something.
  const termHeight =
    (term as unknown as { height?: number }).height ?? 24;
  const maxViewportRows = Math.max(3, termHeight - 6);
  const viewportSize = Math.min(visible.length, maxViewportRows);

  term("\n");

  // selectedIdx 0 = "+ New session"; 1..N = visible sessions in order.
  // scrollOffset is the 0-indexed session that occupies the first viewport
  // row. Adjusted on selection change to keep the cursor in view.
  const total = 1 + visible.length;
  let selectedIdx = 0;
  let scrollOffset = 0;

  const adjustScroll = (): void => {
    if (selectedIdx === 0) {
      return;
    }
    const sessionIdx = selectedIdx - 1;
    if (sessionIdx < scrollOffset) {
      scrollOffset = sessionIdx;
    } else if (sessionIdx >= scrollOffset + viewportSize) {
      scrollOffset = sessionIdx - viewportSize + 1;
    }
  };

  const paintNewItem = (): void => {
    if (selectedIdx === 0) {
      term.brightWhite.bgBlue.noFormat(`❯ ${newSessionLabel}`);
    } else {
      term.noFormat(`  ${newSessionLabel}`);
    }
  };

  const paintSessionRow = (sessionIdx: number): void => {
    const label = sessionLines[sessionIdx] ?? "";
    if (selectedIdx === sessionIdx + 1) {
      term.brightWhite.bgBlue.noFormat(`❯ ${label}`);
    } else {
      term.noFormat(`  ${label}`);
    }
  };

  const formatIndicator = (): string => {
    const above = scrollOffset;
    const below = Math.max(0, visible.length - scrollOffset - viewportSize);
    if (above === 0 && below === 0) {
      return "";
    }
    const parts: string[] = [];
    if (above > 0) {
      parts.push(`↑ ${above} above`);
    }
    if (below > 0) {
      parts.push(`↓ ${below} below`);
    }
    return `  ${parts.join(" · ")}`;
  };

  // Initial paint: "+ New", blank spacer, header, viewport of session
  // rows, scroll indicator. Each followed by \n so the terminal scrolls
  // naturally if the picker's total height exceeds the viewport.
  paintNewItem();
  term("\n\n");
  term.dim.noFormat(`  ${headerLine}`)("\n");
  for (let v = 0; v < viewportSize; v++) {
    paintSessionRow(scrollOffset + v);
    term("\n");
  }
  term.dim.noFormat(formatIndicator())("\n");

  // Compute startRow by reading the cursor (one row past the indicator)
  // and walking back: "+ New" (1) + spacer (1) + header (1) +
  // viewport (viewportSize) + indicator (1) = viewportSize + 4.
  const cursorY = await getCursorY(term);
  const startRow = Math.max(1, cursorY - (viewportSize + 4));
  const newRow = startRow;
  const indicatorRow = startRow + 3 + viewportSize;
  const sessionRow = (sessionIdx: number): number =>
    startRow + 3 + (sessionIdx - scrollOffset);

  const repaintNewItem = (): void => {
    term.moveTo(1, newRow).eraseLineAfter();
    paintNewItem();
  };
  const repaintSessionRow = (sessionIdx: number): void => {
    if (
      sessionIdx < scrollOffset ||
      sessionIdx >= scrollOffset + viewportSize
    ) {
      return;
    }
    term.moveTo(1, sessionRow(sessionIdx)).eraseLineAfter();
    paintSessionRow(sessionIdx);
  };
  const repaintViewport = (): void => {
    for (let v = 0; v < viewportSize; v++) {
      const row = startRow + 3 + v;
      term.moveTo(1, row).eraseLineAfter();
      const sessionIdx = scrollOffset + v;
      if (sessionIdx < visible.length) {
        paintSessionRow(sessionIdx);
      }
    }
    term.moveTo(1, indicatorRow).eraseLineAfter();
    term.dim.noFormat(formatIndicator());
  };

  term.hideCursor();
  return await new Promise<PickerResult>((resolve) => {
    let resolved = false;
    const cleanup = (): void => {
      if (resolved) {
        return;
      }
      resolved = true;
      term.off("key", onKey);
      term.grabInput(false);
      term.hideCursor(false);
      term.moveTo(1, indicatorRow + 1);
      term("\n");
    };
    const move = (delta: number): void => {
      const next = Math.min(total - 1, Math.max(0, selectedIdx + delta));
      if (next === selectedIdx) {
        return;
      }
      const old = selectedIdx;
      const oldScroll = scrollOffset;
      selectedIdx = next;
      adjustScroll();
      if (scrollOffset !== oldScroll) {
        // Viewport scrolled — every session row may have changed. Also
        // refresh "+ New" if its selection state flipped on this move.
        repaintViewport();
        if (old === 0 || selectedIdx === 0) {
          repaintNewItem();
        }
        return;
      }
      // No scroll: just redraw the two rows whose selection state changed.
      if (old === 0) {
        repaintNewItem();
      } else {
        repaintSessionRow(old - 1);
      }
      if (selectedIdx === 0) {
        repaintNewItem();
      } else {
        repaintSessionRow(selectedIdx - 1);
      }
    };
    const onKey = (name: string): void => {
      switch (name) {
        case "UP":
        case "SHIFT_TAB":
          move(-1);
          return;
        case "DOWN":
        case "TAB":
          move(1);
          return;
        case "PAGE_UP":
          move(-viewportSize);
          return;
        case "PAGE_DOWN":
          move(viewportSize);
          return;
        case "HOME":
          move(-total);
          return;
        case "END":
          move(total);
          return;
        case "ENTER":
        case "KP_ENTER": {
          cleanup();
          if (selectedIdx === 0) {
            resolve({ kind: "new" });
            return;
          }
          const session = visible[selectedIdx - 1];
          if (!session) {
            resolve({ kind: "abort" });
            return;
          }
          const result: PickerResult = {
            kind: "attach",
            sessionId: session.sessionId,
          };
          if (session.agentId !== undefined) {
            result.agentId = session.agentId;
          }
          resolve(result);
          return;
        }
        case "ESCAPE":
        case "CTRL_C":
          cleanup();
          resolve({ kind: "abort" });
          return;
      }
    };
    term.grabInput({});
    term.on("key", onKey);
  });
}

function getCursorY(term: Terminal): Promise<number> {
  return new Promise((resolve) => {
    term.getCursorLocation((err, _x, y) => {
      if (err || y === undefined) {
        resolve((term as unknown as { height: number }).height ?? 24);
        return;
      }
      resolve(y);
    });
  });
}

function toRow(s: DiscoveredSession): Row {
  return {
    session: stripHydraSessionPrefix(s.sessionId),
    upstream: s.upstreamSessionId ?? "-",
    status: s.status.toUpperCase(),
    clients: s.status === "cold" ? "-" : String(s.attachedClients),
    agent: s.agentId ?? "?",
    title: s.title ?? "-",
    cwd: s.cwd,
  };
}

function computeWidths(rows: Row[]): Widths {
  return {
    session: maxLen(HEADER.session, rows.map((r) => r.session)),
    upstream: maxLen(HEADER.upstream, rows.map((r) => r.upstream)),
    status: maxLen(HEADER.status, rows.map((r) => r.status)),
    clients: maxLen(HEADER.clients, rows.map((r) => r.clients)),
    agent: maxLen(HEADER.agent, rows.map((r) => r.agent)),
    title: maxLen(HEADER.title, rows.map((r) => r.title)),
  };
}

function maxLen(headerCell: string, values: string[]): number {
  let max = headerCell.length;
  for (const v of values) {
    if (v.length > max) {
      max = v.length;
    }
  }
  return max;
}

function formatRow(r: Row, w: Widths): string {
  return [
    r.session.padEnd(w.session),
    r.upstream.padEnd(w.upstream),
    r.status.padEnd(w.status),
    r.clients.padStart(w.clients),
    r.agent.padEnd(w.agent),
    r.title.padEnd(w.title),
    r.cwd,
  ].join("  ");
}

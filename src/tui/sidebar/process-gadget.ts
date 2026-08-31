// Config-driven sidebar gadget: run a shell command on a timer, show its
// output as a block. Modeled on the composer bar's `$(script)` slots
// (bar/scripts.ts), but multi-line and capped-with-overflow rather than
// squashed to one line.
//
// No pageSize: follows running-tools.ts's capped-overflow pattern rather
// than filesGadget/gitGadget's pageSize pagination. A script's output
// reshuffles on every refresh, which is a bad fit for the shared
// fitPageSize budget every paginated gadget draws from (see
// running-tools.ts's header comment for the fuller rationale).

import type { ProcessGadgetEntry, SidebarGadgetEntry } from "../../core/config.js";
import { sanitizeWireText } from "../../core/render-update.js";
import type { Gadget, SidebarLine } from "./types.js";

export const DEFAULT_PROCESS_GADGET_CAP = 6;

// Parses [text](url) spans out of plain text — CommonMark's "balanced
// parens inside the URL" rule, mirroring format.ts's
// applyInlineMarkupWithLinks (format.ts:611-691), but link-only: no
// nested bold/italic/code, no styling escapes. Process-gadget output is
// raw shell text, not authored prose, so it never needs the rest of that
// pipeline — and since sanitizeProcessOutput already stripped ANSI
// before this runs, there's no raw/clean offset split to track either;
// `body` IS what gets painted, and link offsets index directly into it.
// Malformed/unbalanced brackets are left as literal text, never thrown.
export function extractMarkdownLinks(text: string): {
  body: string;
  links: Array<{ start: number; end: number; url: string }>;
} {
  let body = "";
  const links: Array<{ start: number; end: number; url: string }> = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "[") {
      const closeBracket = text.indexOf("]", i + 1);
      if (
        closeBracket !== -1 &&
        text[closeBracket + 1] === "(" &&
        closeBracket > i + 1
      ) {
        let closeParen = -1;
        let depth = 1;
        let j = closeBracket + 2;
        while (j < text.length) {
          const ch = text[j];
          if (ch === "\\" && j + 1 < text.length) {
            j += 2;
            continue;
          }
          if (ch === "(") {
            depth += 1;
          } else if (ch === ")") {
            depth -= 1;
            if (depth === 0) {
              closeParen = j;
              break;
            }
          }
          j += 1;
        }
        if (closeParen !== -1 && closeParen > closeBracket + 2) {
          const linkText = text.slice(i + 1, closeBracket);
          const url = text.slice(closeBracket + 2, closeParen);
          const start = body.length;
          body += linkText;
          links.push({ start, end: body.length, url });
          i = closeParen + 1;
          continue;
        }
      }
    }
    body += c;
    i += 1;
  }
  return { body, links };
}

// ANSI is stripped rather than passed through — same call the transcript
// pipeline already makes for tool output (sanitizeWireText strips at
// ingestion; any color shown is the app's own re-theming, not the
// subprocess's). Unlike the bar's single-line sanitize(), newlines survive.
export function sanitizeProcessOutput(stdout: string): string | null {
  const cleaned = sanitizeWireText(stdout).trim();
  return cleaned.length === 0 ? null : cleaned;
}

export function isProcessGadgetEntry(
  entry: SidebarGadgetEntry,
): entry is ProcessGadgetEntry {
  return typeof entry !== "string";
}

// The id the ordering/visibility system (SidebarRenderer.setGadgets) uses
// for a mixed string-or-object entry.
export function sidebarGadgetId(entry: SidebarGadgetEntry): string {
  return typeof entry === "string" ? entry : entry.id;
}

// Every process-gadget config in a sidebar.gadgets list, in configured
// order. Two entries naming the same script still each get their own
// gadget id/instance — only the underlying subprocess execution and
// token dedupe by command string (see shared/process-runner.ts).
export function collectSidebarGadgetConfigs(
  entries: readonly SidebarGadgetEntry[],
): ProcessGadgetEntry[] {
  return entries.filter(isProcessGadgetEntry);
}

// Command -> effective refresh interval, same shape and dedup rule as
// bar/scripts.ts's collectScriptCommands (min of any conflicting
// refreshMs). Shared by the token-mint batch (runTuiApp) and the sidebar
// poller (runSession) so both agree on the same command set.
export function collectSidebarGadgetCommands(
  entries: readonly SidebarGadgetEntry[],
  defaultRefreshMs: number,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const gadget of collectSidebarGadgetConfigs(entries)) {
    const refreshMs = gadget.refreshMs ?? defaultRefreshMs;
    const existing = out.get(gadget.script);
    out.set(
      gadget.script,
      existing === undefined ? refreshMs : Math.min(existing, refreshMs),
    );
  }
  return out;
}

export function createProcessGadget(cfg: ProcessGadgetEntry): Gadget {
  return {
    id: cfg.id,
    title: cfg.title ?? cfg.id,
    // Hidden rather than placeholder'd while there's nothing to show — no
    // output yet and a run that came back empty are the same state
    // (setProcessOutput deletes the entry either way), and the sidebar's
    // convention is relevant()-gated hiding, not a "waiting…" row (see
    // gitGadget/toolsGadget). A gadget author who wants a visible "nothing
    // found" message writes it into the script's own output, same as the
    // `|| echo 'no PR'` pattern.
    relevant: (snapshot) => snapshot.processOutputs.has(cfg.script),
    versionKey: (snapshot, ctx) =>
      `${ctx.width}:${snapshot.processOutputs.get(cfg.script) ?? ""}`,
    render: (snapshot, ctx) => {
      const raw = snapshot.processOutputs.get(cfg.script);
      if (raw === undefined) {
        return [];
      }
      const { truncate } = ctx.metrics;
      const lines = raw.split("\n").filter((line) => line.length > 0);
      const cap = cfg.cap ?? DEFAULT_PROCESS_GADGET_CAP;
      const shown: SidebarLine[] = lines.slice(0, cap).map((line) => {
        const { body, links } = extractMarkdownLinks(line);
        const truncated = truncate(body, ctx.width);
        // Clip spans to what survived truncation — a span whose start was
        // cut off entirely is dropped, one that was partially cut keeps
        // only the surviving prefix.
        const clipped = links
          .filter((l) => l.start < truncated.length)
          .map((l) => ({ ...l, end: Math.min(l.end, truncated.length) }));
        return clipped.length > 0
          ? { body: truncated, links: clipped }
          : { body: truncated };
      });
      if (lines.length > cap) {
        shown.push({
          body: `  +${lines.length - cap} more`,
          bodyStyle: "muted",
        });
      }
      return shown;
    },
  };
}

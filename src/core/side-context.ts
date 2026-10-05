import type { SideInfo } from "../acp/types-side.js";

// A side chat's copied history is context for the agent; clients see only what came after it.
export function ownEntries<T extends { seq?: number }>(entries: readonly T[], side: SideInfo | undefined): T[] {
  const through = side?.contextThroughSeq;
  if (through === undefined) {
    return [...entries];
  }
  return entries.filter((entry) => entry.seq === undefined || entry.seq > through);
}

// The highest seq among the history copied into a side chat; absent when none of it carries a seq.
export function contextBoundary(copied: readonly { seq?: number }[]): { contextThroughSeq?: number } {
  let through: number | undefined;
  for (const entry of copied) {
    if (entry.seq !== undefined && (through === undefined || entry.seq > through)) {
      through = entry.seq;
    }
  }
  return through === undefined ? {} : { contextThroughSeq: through };
}

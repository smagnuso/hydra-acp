// Read the upstream generation chain as a compaction history.
//
// `upstreamGenerations` records every rotation a session ever made, but
// `reason` only exists on entries written after it was added. Everything
// here is about not lying across that boundary: an entry with no reason
// is UNKNOWN, and a count that includes unknowns is a lower bound, not a
// figure. Treating unknown as compaction would count workspace moves and
// agent switches; treating it as not-compaction would tell a session that
// compacted five times last week that it has never been compacted.
//
// Three reasons ARE recoverable from old data with certainty, so we take
// them rather than shrug:
//   - agentId differs from the previous entry  -> cross-agent swap
//   - upstreamSessionId seen earlier in the chain -> rollback re-entry
//   - the session's watermark never moved      -> nothing was a compaction
// Workspace moves are NOT recoverable: per-generation cwd is not stored.

import type {
  UpstreamGeneration,
  UpstreamGenerationReason,
} from "./session-store.js";

export interface Rotation {
  upstreamSessionId: string;
  agentId: string;
  // When this generation began == when the rotation happened. Absent on
  // an entry seeded by the back-fill, which never had one recorded.
  at?: string;
  endedAt?: string;
  cost?: number;
  // Recorded at rotation time. Authoritative when present.
  reason?: UpstreamGenerationReason;
  // Derived after the fact, and only where the chain proves it. Never
  // overrides a recorded reason.
  inferredReason?: UpstreamGenerationReason;
  // True when the reason is unknown but provably not a compaction (the
  // session's watermark never moved). Keeps these out of the unknown
  // bucket so a never-compacted session doesn't report a lower bound it
  // doesn't need.
  notCompaction?: boolean;
}

export interface CompactionHistory {
  // Every rotation, oldest first. Excludes generations[0], which is the
  // upstream the session started on rather than a rotation onto one.
  rotations: Rotation[];
  compactions: Rotation[];
  // Rotations whose cause is genuinely unrecoverable. When > 0 the
  // compaction count is a floor.
  unknownCount: number;
}

export function readCompactionHistory(
  generations: ReadonlyArray<UpstreamGeneration> | undefined,
  summarizedThroughEntry: number | undefined,
): CompactionHistory {
  const all = generations ?? [];
  // A session that never advanced its watermark never completed a
  // compaction swap — the watermark is what a compaction moves, and it
  // only ever moves forward. So every reasonless rotation on such a
  // session is knowable as not-a-compaction even though its actual cause
  // is lost.
  const everCompacted = (summarizedThroughEntry ?? 0) > 0;
  const rotations: Rotation[] = [];
  const seenUpstreams = new Set<string>();
  const first = all[0];
  if (first) {
    seenUpstreams.add(first.upstreamSessionId);
  }

  for (let i = 1; i < all.length; i++) {
    const gen = all[i]!;
    const prev = all[i - 1]!;
    const rotation: Rotation = {
      upstreamSessionId: gen.upstreamSessionId,
      agentId: gen.agentId,
      ...(gen.startedAt !== undefined ? { at: gen.startedAt } : {}),
      ...(gen.endedAt !== undefined ? { endedAt: gen.endedAt } : {}),
      ...(gen.cost !== undefined ? { cost: gen.cost } : {}),
      ...(gen.reason !== undefined ? { reason: gen.reason } : {}),
    };
    if (gen.reason === undefined) {
      if (gen.agentId !== prev.agentId) {
        rotation.inferredReason = "agent-swap";
      } else if (seenUpstreams.has(gen.upstreamSessionId)) {
        rotation.inferredReason = "rollback";
      } else if (!everCompacted) {
        rotation.notCompaction = true;
      }
    }
    seenUpstreams.add(gen.upstreamSessionId);
    rotations.push(rotation);
  }

  return {
    rotations,
    compactions: rotations.filter((r) => r.reason === "compaction"),
    unknownCount: rotations.filter(
      (r) => r.reason === undefined && r.inferredReason === undefined && !r.notCompaction,
    ).length,
  };
}

// "2026-08-19T21:25Z". Minute precision, UTC, matching the ISO
// timestamps `hydra session info` already prints — a local-time render
// would be friendlier but makes the output depend on the reader's TZ,
// which is the wrong tradeoff for a value people paste into bug reports.
export function formatRotationTime(iso: string | undefined): string {
  if (!iso) {
    return "unknown time";
  }
  const t = Date.parse(iso);
  if (Number.isNaN(t)) {
    return "unknown time";
  }
  return `${new Date(t).toISOString().slice(0, 16)}Z`;
}

/**
 * The history section of `/hydra compact status`.
 *
 * Returns [] when there is nothing to say, so the caller can decide
 * whether "never been compacted" is the right message given the rest of
 * the state it knows about.
 */
export function formatCompactionHistory(history: CompactionHistory): string[] {
  const { compactions, unknownCount } = history;
  const lines: string[] = [];

  if (compactions.length > 0) {
    lines.push(
      compactions.length === 1
        ? "Compacted 1 time:"
        : `Compacted ${compactions.length} times:`,
    );
    for (const c of compactions) {
      const cost = c.cost !== undefined ? `  $${c.cost.toFixed(2)}` : "";
      const live = c.endedAt === undefined ? "  (current)" : "";
      lines.push(
        `  ${formatRotationTime(c.at)}  ${c.upstreamSessionId}${cost}${live}`,
      );
    }
  }

  if (unknownCount > 0) {
    // Stated separately rather than folded into the count: these are
    // rotations from before reasons were recorded, and any of them could
    // have been a compaction.
    const noun = unknownCount === 1 ? "rotation" : "rotations";
    lines.push(
      compactions.length > 0
        ? // There IS a count above, so name it as a floor.
          `${unknownCount} earlier ${noun}, cause not recorded — the count above is a lower bound.`
        : // There is no count above; a bare "lower bound" would dangle.
          // Saying "never compacted" here would be the actual lie: any of
          // these could have been one.
          `No compactions on record. ${unknownCount} ${noun} predate reason tracking, ` +
          `and any of them may have been a compaction.`,
    );
  }

  return lines;
}

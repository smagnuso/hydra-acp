// Ask the terminal how wide it actually draws ambiguous-width glyphs, by
// measuring where the cursor lands after drawing them.
//
// East-Asian "Ambiguous" is a real category with no right answer: the same
// codepoint is 1 column in xterm and 2 in a CJK-configured terminal, and the
// difference is a *rendering* choice the terminal makes, not a property of the
// text. Every non-measuring approach is a guess:
//
//   - LC_*/LANG says what language the user reads, not what the emulator does.
//   - TERM_PROGRAM says which emulator it is, but not how it is configured —
//     Terminal.app has a per-profile "East Asian ambiguous characters are
//     wide" switch, off by default, and the env var cannot see it.
//
// So we measure instead. There is no query that reports the policy, but the
// cursor position report reports its *effect*:
//
//     ->  CSI 6n              <-  CSI row ; col R      (baseline)
//     ->  "─"
//     ->  CSI 6n              <-  CSI row ; col R      (col advanced 1 or 2)
//
// The delta is the answer, and it is authoritative in a way a heuristic cannot
// be: it comes from the same width table the thing doing the layout uses. Under
// tmux the reply is tmux's own table, which is exactly right, since tmux is
// what places the cells.
//
// Costs one round trip at startup, bounded by a timeout, and one line of
// terminal output that is erased before anything else draws. Risks a reply
// arriving after we stop listening, which is why installReplyFilter scrubs late
// CPRs the same way it scrubs late OSC 11 replies.

/** How long to wait for the replies before giving up and falling back. */
const DEFAULT_TIMEOUT_MS = 200;

const CPR_QUERY = "\u001b[6n";

/**
 * The glyphs whose width actually changes this TUI's layout.
 *
 * Not a survey of the Ambiguous block — these are the specific characters the
 * chrome is built out of, so a wrong answer about any one of them is a visible
 * bug. Box-drawing (`─` `│`) rules and sidebar gutters, the eighth-block
 * (`▏`) and middle-dot (`·`) that make up the context bar, the ellipsis (`…`)
 * every truncate appends, and the todo status marks (`✓` `▸`).
 */
export const PROBE_GLYPHS = ["─", "│", "·", "▏", "…", "✓", "▸"] as const;

/** Per-glyph measured widths, keyed by the glyph. */
export type GlyphWidths = Record<string, number>;

export interface WidthProbeResult {
  /** What to feed setAmbiguousWide: true when most probed glyphs drew 2 cols. */
  wide: boolean;
  /** Every glyph's measured column count, for the debug log. */
  widths: GlyphWidths;
}

/**
 * The escape string that measures `glyphs` in a single round trip.
 *
 * One CPR before the first glyph and one after each, so N glyphs cost N+1
 * replies and the deltas fall out pairwise. Terminals answer CPRs in order, so
 * batching is safe and saves N-1 round trips over probing one at a time.
 *
 * Opens a fresh line rather than reusing the current one: the sequence ends by
 * erasing the line it drew on, and that must never be a line something else
 * printed (a password prompt on the remote-attach path, say). Ends with CR +
 * erase, leaving the cursor at column 1 of a now-blank line, so the next thing
 * to write overwrites it and the probe leaves no visible trace. The erase is
 * written unconditionally — a terminal that ignores CPR still must not be left
 * with `─│·▏…✓▸` printed on it.
 */
export function buildProbeSequence(
  glyphs: readonly string[] = PROBE_GLYPHS,
): string {
  let out = "\n\r" + CPR_QUERY;
  for (const g of glyphs) {
    out += g + CPR_QUERY;
  }
  return out + "\r\u001b[K";
}

/** Every CPR reply in `data`, in order, as [row, col] pairs. */
export function parseCprReports(data: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const re = /\u001b\[(\d+);(\d+)R/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(data)) !== null) {
    out.push([Number(m[1]), Number(m[2])]);
  }
  return out;
}

/** Whether `data` contains anything that looks like a CPR reply. */
export function hasCprReport(data: string): boolean {
  return /\u001b\[\d+;\d+R/.test(data);
}

/**
 * Remove CPR replies from a string.
 *
 * For one that arrives after we have stopped waiting. terminal-kit does decode
 * CPR, so an unscrubbed late reply would surface as a spurious cursor-location
 * event rather than as literal text — less destructive than a stray OSC 11, but
 * still a report about a question nobody currently has outstanding.
 */
export function scrubCprReports(data: string): string {
  return data.replace(/\u001b\[\d+;\d+R/g, "");
}

/**
 * Turn CPR replies into per-glyph widths.
 *
 * Rejects the whole measurement rather than trusting part of it:
 *   - fewer replies than glyphs means we cannot attribute the deltas;
 *   - a row change means the line wrapped and the column delta is meaningless;
 *   - a delta outside 1..2 means we are not reading what we think we are.
 * A partly-wrong width table is worse than none, because the fallback
 * heuristic is at least self-consistent.
 */
export function widthsFromReports(
  reports: ReadonlyArray<readonly [number, number]>,
  glyphs: readonly string[] = PROBE_GLYPHS,
): GlyphWidths | undefined {
  if (reports.length < glyphs.length + 1) {
    return undefined;
  }
  const widths: GlyphWidths = {};
  for (let i = 0; i < glyphs.length; i++) {
    const [prevRow, prevCol] = reports[i]!;
    const [row, col] = reports[i + 1]!;
    if (row !== prevRow) {
      return undefined;
    }
    const delta = col - prevCol;
    if (delta !== 1 && delta !== 2) {
      return undefined;
    }
    widths[glyphs[i]!] = delta;
  }
  return widths;
}

/**
 * Collapse a width table into the single boolean cellWidth() consumes.
 *
 * Majority vote, because terminals are not internally consistent across the
 * Ambiguous set and one boolean cannot represent the disagreement. Ties go
 * narrow: over-counting shrinks every budget in the TUI, so the failure mode of
 * guessing wide is worse than the failure mode of guessing narrow.
 */
export function isAmbiguousWide(widths: GlyphWidths): boolean {
  const values = Object.values(widths);
  if (values.length === 0) {
    return false;
  }
  const wide = values.filter((w) => w === 2).length;
  return wide > values.length / 2;
}

interface ProbeStreams {
  input: {
    isTTY?: boolean;
    setRawMode?: (mode: boolean) => unknown;
    on: (event: "data", fn: (chunk: Buffer | string) => void) => unknown;
    off?: (event: "data", fn: (chunk: Buffer | string) => void) => unknown;
    removeListener?: (
      event: "data",
      fn: (chunk: Buffer | string) => void,
    ) => unknown;
    resume?: () => unknown;
    pause?: () => unknown;
    isPaused?: () => boolean;
  };
  output: { isTTY?: boolean; write: (s: string) => unknown; columns?: number };
}

/**
 * Measure this terminal's ambiguous-glyph widths. Resolves undefined when it
 * does not answer in time, which is the normal outcome for anything that does
 * not implement CPR and must therefore cost nothing but the timeout.
 *
 * Runs before the TUI grabs input, so it does its own minimal raw-mode setup
 * and puts the stream back exactly as it found it — see senseTerminalColors, which
 * this deliberately mirrors. Only ever resolves: a failure here must never be
 * the reason the TUI does not start.
 */
export async function probeAmbiguousWidth(
  streams: ProbeStreams = { input: process.stdin, output: process.stdout },
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  glyphs: readonly string[] = PROBE_GLYPHS,
): Promise<WidthProbeResult | undefined> {
  const { input, output } = streams;
  if (input.isTTY !== true || output.isTTY !== true) {
    return undefined;
  }
  // The probe line is one cell per glyph. On a terminal too narrow to hold it
  // the line wraps, the deltas stop meaning anything, and we would reject the
  // result anyway — so skip the round trip instead of paying for it.
  if ((output.columns ?? 80) < glyphs.length + 2) {
    return undefined;
  }
  return await new Promise<WidthProbeResult | undefined>((resolve) => {
    let buf = "";
    let done = false;
    const wasPaused = input.isPaused?.() ?? false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: WidthProbeResult | undefined): void => {
      if (done) {
        return;
      }
      done = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      try {
        (input.off ?? input.removeListener)?.call(input, "data", onData);
        // Put the stream back as we found it: the caller sets up its own input
        // handling next, and inheriting raw mode from a probe is the kind of
        // thing that turns into a keyboard that does not work.
        input.setRawMode?.(false);
        if (wasPaused) {
          input.pause?.();
        }
      } catch {
        // Restoring is best-effort. A terminal that cannot be put back is not a
        // reason to fail startup.
      }
      resolve(result);
    };

    const onData = (chunk: Buffer | string): void => {
      buf += typeof chunk === "string" ? chunk : chunk.toString("latin1");
      const reports = parseCprReports(buf);
      if (reports.length < glyphs.length + 1) {
        return;
      }
      const widths = widthsFromReports(reports, glyphs);
      finish(
        widths === undefined
          ? undefined
          : { wide: isAmbiguousWide(widths), widths },
      );
    };

    try {
      input.setRawMode?.(true);
      input.resume?.();
      input.on("data", onData);
      output.write(buildProbeSequence(glyphs));
    } catch {
      finish(undefined);
      return;
    }
    timer = setTimeout(() => finish(undefined), timeoutMs);
    // Never hold the process open on the timeout alone.
    (timer as unknown as { unref?: () => void }).unref?.();
  });
}

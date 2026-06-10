// Overlay buffer — accumulates SessionUpdate events into a single-stream
// display line buffer, reusing the formatters from format.ts so styling
// stays consistent with the screen layer without importing it.

import {
  formatEvent,
  formatToolLine,
  type FormattedLine,
  type ToolLineState,
} from "../format.js";
import { mapUpdate } from "../../core/render-update.js";

type ChangedListener = () => void;

// Minimal typed emitter — no external dependency, just what the overlay
// needs to notify a single consumer when its line buffer mutates.
class TypedEmitter<C extends Record<string, unknown>> {
  private readonly _listeners = new Map<keyof C, Set<C[keyof C]>>() as Map<
    string,
    Set<ChangedListener>
  >;

  on<K extends keyof C>(event: K, fn: C[K]): void {
    let set = this._listeners.get(event as string);
    if (!set) {
      set = new Set();
      this._listeners.set(event as string, set);
    }
    set.add(fn as ChangedListener);
  }

  off<K extends keyof C>(event: K, fn: C[K]): void {
    const set = this._listeners.get(event as string);
    set?.delete(fn as ChangedListener);
  }

  protected emit<K extends keyof C>(event: K): void {
    const set = this._listeners.get(event as string);
    set?.forEach((fn) => fn());
  }
}

export interface OverlayBufferOptions {
  // When set, the buffer emits a "changed" event after every mutation.
  // Default is true.
  emitChanged?: boolean;
}

export class BtwOverlayBuffer extends TypedEmitter<{ changed: () => void }> {
  // Lines are stored as FormattedLine so the screen layer can apply the
  // same per-style painting it uses for the main transcript (background
  // bands on user turns, bright blue on tool labels, etc.). Flattening
  // to strings would drop bodyStyle / fillRow and the overlay would
  // render every line as plain text — wrong for user-text especially.
  private readonly _lines: FormattedLine[] = [];
  // Accumulated state keyed by toolCallId so that a tool_call followed
  // by one or more tool_call_update events produces a single coherent
  // rendering (the same pattern the screen layer uses for keyed blocks).
  private readonly _toolStates = new Map<string, ToolLineState>();
  // For each toolCallId, remember which [start, length] slice of _lines
  // its rendering currently occupies. tool_call_update events replace
  // that slice in place rather than appending, so progressive updates
  // produce a single coherent block instead of stacking duplicates.
  private readonly _toolRanges = new Map<
    string,
    { start: number; length: number }
  >();
  // Coalesce consecutive agent_message_chunk events into a single
  // paragraph: as new chunks arrive their text concatenates with the
  // pending paragraph, the prior rendered range is replaced in place.
  // Any non-agent-text event (tool_call, plan, etc.) seals the paragraph
  // and the next agent-text event starts a new one.
  private _pendingAgentText: string | null = null;
  private _pendingAgentRange: { start: number; length: number } | null = null;
  private readonly _emitChanged: boolean;

  constructor(options: OverlayBufferOptions = {}) {
    super();
    this._emitChanged = options.emitChanged ?? true;
  }

  // Append a raw SessionUpdate, format it into display lines via the
  // existing formatters, and append those lines to the buffer. Returns
  // the number of lines added (zero for events that carry no visual
  // representation).
  append(update: unknown): number {
    const event = mapUpdate(update);
    if (!event) return 0;

    // Most kinds end the pending agent-text paragraph. agent-text itself
    // is handled below (it APPENDS to the paragraph instead).
    if (event.kind !== "agent-text") {
      this._pendingAgentText = null;
      this._pendingAgentRange = null;
    }

    switch (event.kind) {
      case "agent-text": {
        const chunk = event.text;
        if (this._pendingAgentText !== null && this._pendingAgentRange !== null) {
          // Continue the paragraph: concat the text and re-format the
          // whole accumulated string, then replace the prior range with
          // the new lines.
          this._pendingAgentText += chunk;
          const lines = formatEvent({
            kind: "agent-text",
            text: this._pendingAgentText,
          });
          this._replaceAgentRange(this._pendingAgentRange, lines);
          return lines.length;
        }
        this._pendingAgentText = chunk;
        const lines = formatEvent(event);
        const start = this._lines.length;
        this._pushLines(lines);
        this._pendingAgentRange = { start, length: lines.length };
        return lines.length;
      }

      case "tool-call": {
        const state: ToolLineState = {
          initialTitle: event.title,
          latestTitle: event.title,
          status: event.status ?? "pending",
        };
        if (event.detail !== undefined) state.detail = event.detail;
        this._toolStates.set(event.toolCallId, state);
        const lines = formatToolLine(state);
        const start = this._lines.length;
        this._pushLines(lines);
        this._toolRanges.set(event.toolCallId, {
          start,
          length: lines.length,
        });
        return lines.length;
      }

      case "tool-call-update": {
        const existing = this._toolStates.get(event.toolCallId);
        if (!existing) return 0;

        if (event.title !== undefined) existing.latestTitle = event.title;
        if (event.status !== undefined) existing.status = event.status;
        if (event.detail !== undefined) existing.detail = event.detail;
        if (event.errorText !== undefined) existing.errorText = event.errorText;

        const lines = formatToolLine(existing);
        const range = this._toolRanges.get(event.toolCallId);
        if (!range) {
          const start = this._lines.length;
          this._pushLines(lines);
          this._toolRanges.set(event.toolCallId, {
            start,
            length: lines.length,
          });
          return lines.length;
        }
        this._replaceRange(event.toolCallId, range, lines);
        return lines.length;
      }

      default: {
        const lines = formatEvent(event);
        this._pushLines(lines);
        return lines.length;
      }
    }
  }

  // Replace the lines occupying the pending-agent-text range with new
  // ones, shifting any tool ranges that sit below by the delta. Mirrors
  // _replaceRange but targets the agent paragraph slot.
  private _replaceAgentRange(
    range: { start: number; length: number },
    formatted: FormattedLine[],
  ): void {
    const delta = formatted.length - range.length;
    this._lines.splice(range.start, range.length, ...formatted);
    range.length = formatted.length;
    if (delta !== 0) {
      for (const r of this._toolRanges.values()) {
        if (r.start > range.start) r.start += delta;
      }
    }
    if (this._emitChanged) {
      this.emit("changed");
    }
  }

  // Replace [start, start+length) of _lines with the new formatted lines.
  // Subsequent toolCallId ranges shift by the delta. Emits "changed".
  private _replaceRange(
    toolCallId: string,
    range: { start: number; length: number },
    formatted: FormattedLine[],
  ): void {
    const delta = formatted.length - range.length;
    this._lines.splice(range.start, range.length, ...formatted);
    range.length = formatted.length;
    if (delta !== 0) {
      for (const [id, r] of this._toolRanges) {
        if (id === toolCallId) continue;
        if (r.start > range.start) {
          r.start += delta;
        }
      }
      if (this._pendingAgentRange && this._pendingAgentRange.start > range.start) {
        this._pendingAgentRange.start += delta;
      }
    }
    if (this._emitChanged) {
      this.emit("changed");
    }
  }

  getLines(): FormattedLine[] {
    return this._lines.slice();
  }

  clear(): void {
    if (this._lines.length > 0 || this._toolStates.size > 0) {
      this._lines.length = 0;
      this._toolStates.clear();
      this._toolRanges.clear();
      this._pendingAgentText = null;
      this._pendingAgentRange = null;
      this.emit("changed");
    }
  }

  get size(): number {
    return this._lines.length;
  }

  private _pushLines(formatted: FormattedLine[]): void {
    const before = this._lines.length;
    for (const fl of formatted) {
      this._lines.push(fl);
    }
    if (this._emitChanged && this._lines.length > before) {
      this.emit("changed");
    }
  }
}

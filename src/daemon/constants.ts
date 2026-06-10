// Centralized magic numbers for acp-ws.ts.

// Hard cap on caller-supplied timeoutMs for session/await_child.
export const AWAIT_CHILD_MAX_TIMEOUT_MS = 30 * 60_000;

// Default timeoutMs for session/await_child when not supplied.
export const AWAIT_CHILD_DEFAULT_TIMEOUT_MS = 5 * 60_000;

// Cap on simulated inter-notification delay during a dripped replay,
// so multi-minute idle gaps in the original turn don't stall playback.
export const REPLAY_DRIP_MAX_GAP_MS = 750;

// Await every N notifications during non-drip replay to retain coarse
// backpressure without paying a write-callback round-trip per entry.
export const REPLAY_FLUSH_EVERY = 200;

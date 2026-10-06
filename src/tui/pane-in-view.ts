import type { TerminalHost } from "./term-host/types.js";

const HOST_TIMEOUT_MS = 1_000;

// Whether the person can see this pane, for marking its session read.
// The terminal's own focus report decides when it says unfocused; a host
// that does not forward focus reports (herdr) is asked next; with neither
// able to say, the pane counts as in view.
export async function paneInView(opts: {
  terminalFocused: boolean;
  host: TerminalHost | null;
  timeoutMs?: number;
}): Promise<boolean> {
  if (!opts.terminalFocused) {
    return false;
  }
  const host = opts.host;
  if (!host?.caps.focus || !host.isFocused) {
    return true;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), opts.timeoutMs ?? HOST_TIMEOUT_MS);
  });
  try {
    const focused = await Promise.race([host.isFocused().catch(() => null), timeout]);
    return focused !== false;
  } finally {
    clearTimeout(timer);
  }
}

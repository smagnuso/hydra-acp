import * as os from "node:os";

// The identity used to stamp `bundle.exportedFrom.machine` when a
// session is exported, and to recognize a self-import on the way
// back in (see picker.filterByHost). Keeping this single-sourced
// means the stamp and the comparison never drift — a future change
// to normalization (e.g. lowercasing) automatically applies to both
// sides.
//
// os.hostname() is the primitive because that's what the exporter
// has always written. Derived forms (mDNS `.local` suffix, host:port
// share URLs) are separate concerns and live at their call sites.
export function thisMachine(): string {
  return os.hostname();
}

// Callers that want to accept multiple hostnames as "the same box"
// (e.g. a laptop that toggles between `mybox` and `mybox.local`)
// can layer HYDRA_ACP_LOCAL_HOSTS on top. Consumed by the TUI picker's
// __local host filter.
export function localMachines(): Set<string> {
  const out = new Set<string>();
  out.add(thisMachine());
  const extras = process.env.HYDRA_ACP_LOCAL_HOSTS;
  if (extras) {
    for (const h of extras.split(",")) {
      const trimmed = h.trim();
      if (trimmed) out.add(trimmed);
    }
  }
  return out;
}

import { describe, it, expect, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import { HydraConfig } from "./config.js";
import { startConfigReloader } from "./config-reload.js";
import { paths } from "./paths.js";

const stops: Array<() => void> = [];

afterEach(async () => {
  while (stops.length > 0) {
    stops.pop()?.();
  }
  await fsp.rm(paths.config(), { force: true });
});

function base(): HydraConfig {
  return HydraConfig.parse({});
}

async function writeConfig(data: Record<string, unknown>): Promise<void> {
  await fsp.mkdir(paths.home(), { recursive: true });
  await fsp.writeFile(paths.config(), JSON.stringify(data), "utf8");
}

// Poll fast so the tests don't sit on a 3s interval.
function start(opts: {
  apply?: (next: HydraConfig) => void;
  onDrift?: (keys: string[]) => void;
}): void {
  stops.push(
    startConfigReloader({
      bootConfig: base(),
      apply: opts.apply ?? (() => undefined),
      ...(opts.onDrift ? { onDrift: opts.onDrift } : {}),
      intervalMs: 15,
    }),
  );
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timed out waiting for the reloader");
}

describe("startConfigReloader", () => {
  it("detects an edit that lands before the first poll", async () => {
    // Regression: priming used to happen on the FIRST TICK rather than at
    // construction, so the baseline was captured one interval after boot
    // and any edit inside that window was swallowed. That's the most
    // likely case in practice — change something right after starting the
    // daemon — and it looked exactly like "hot reload doesn't work".
    await writeConfig({ defaultAgent: "before" });
    const seen: string[] = [];
    start({ apply: (next) => seen.push(next.defaultAgent) });
    // No await between start and the edit: the edit races the first poll.
    await writeConfig({ defaultAgent: "after" });
    await waitFor(() => seen.includes("after"));
    expect(seen).toContain("after");
  });

  it("applies a later edit and reports no drift for live-tier keys", async () => {
    await writeConfig({ defaultAgent: "one" });
    const seen: string[] = [];
    const drifts: string[][] = [];
    start({
      apply: (next) => seen.push(next.defaultAgent),
      onDrift: (keys) => drifts.push(keys),
    });
    await new Promise((r) => setTimeout(r, 50));
    await writeConfig({ defaultAgent: "two" });
    await waitFor(() => seen.includes("two"));
    expect(drifts.at(-1)).toEqual([]);
  });

  it("reports warn-tier drift against the BOOT config, not the previous poll", async () => {
    await writeConfig({});
    const drifts: string[][] = [];
    start({ onDrift: (keys) => drifts.push(keys) });
    await new Promise((r) => setTimeout(r, 50));
    await writeConfig({ synopsisModel: "haiku" });
    await waitFor(() => (drifts.at(-1) ?? []).includes("synopsisModel"));

    // Revert: drift clears, because it's measured from boot rather than
    // accumulated. A key edited and put back must stop being reported.
    await writeConfig({});
    await waitFor(() => (drifts.at(-1) ?? []).length === 0);
    expect(drifts.at(-1)).toEqual([]);
  });

  it("keeps the loaded config when the file becomes unparseable", async () => {
    await writeConfig({ defaultAgent: "good" });
    const seen: string[] = [];
    start({ apply: (next) => seen.push(next.defaultAgent) });
    await new Promise((r) => setTimeout(r, 50));
    await fsp.writeFile(paths.config(), "{ not json", "utf8");
    await new Promise((r) => setTimeout(r, 100));
    // Nothing applied from the broken file.
    expect(seen).not.toContain(undefined);
    // And a subsequent good write still lands, so one bad save doesn't
    // wedge the watcher.
    await writeConfig({ defaultAgent: "recovered" });
    await waitFor(() => seen.includes("recovered"));
  });

  it("stops polling once stopped", async () => {
    await writeConfig({ defaultAgent: "one" });
    const seen: string[] = [];
    const stop = startConfigReloader({
      bootConfig: base(),
      apply: (next) => seen.push(next.defaultAgent),
      intervalMs: 15,
    });
    await new Promise((r) => setTimeout(r, 50));
    stop();
    await writeConfig({ defaultAgent: "after-stop" });
    await new Promise((r) => setTimeout(r, 100));
    expect(seen).not.toContain("after-stop");
  });
});

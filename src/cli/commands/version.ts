import { loadConfig } from "../../core/config.js";
import { loadServiceToken } from "../../core/service-token.js";
import { fetchDaemonHealth } from "../../core/daemon-bootstrap.js";
import { HYDRA_VERSION } from "../../core/hydra-version.js";
import { httpBase } from "./sessions.js";

interface ComponentInfo {
  name: string;
  version: string | null;
  status: string;
}

interface VersionReport {
  cli: string;
  daemon: string | null;
  daemonReachable: boolean;
  extensions: ComponentInfo[];
  transformers: ComponentInfo[];
}

export async function runVersion(opts: { json?: boolean } = {}): Promise<void> {
  const { report, configLoaded } = await collectVersionReport();
  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }
  process.stdout.write(`CLI:    ${report.cli}\n`);
  if (!configLoaded) {
    return;
  }
  process.stdout.write(
    `Daemon: ${report.daemon ?? (report.daemonReachable ? "unknown" : "not running")}\n`,
  );
  if (!report.daemonReachable) {
    return;
  }
  printSection("Extensions", report.extensions);
  printSection("Transformers", report.transformers);
}

function printSection(label: string, rows: ComponentInfo[]): void {
  process.stdout.write(`\n${label}:\n`);
  if (rows.length === 0) {
    process.stdout.write("  (none)\n");
    return;
  }
  const nameWidth = Math.max(...rows.map((r) => r.name.length));
  const verWidth = Math.max(
    ...rows.map((r) => (r.version ?? "-").length),
    "VERSION".length,
  );
  for (const r of rows) {
    const v = r.version ?? "-";
    process.stdout.write(
      `  ${r.name.padEnd(nameWidth)}  ${v.padEnd(verWidth)}  ${r.status}\n`,
    );
  }
}

async function collectVersionReport(): Promise<{
  report: VersionReport;
  configLoaded: boolean;
}> {
  const report: VersionReport = {
    cli: HYDRA_VERSION,
    daemon: null,
    daemonReachable: false,
    extensions: [],
    transformers: [],
  };
  let config;
  try {
    config = await loadConfig();
  } catch {
    return { report, configLoaded: false };
  }
  const health = await fetchDaemonHealth(config);
  if (health !== undefined) {
    report.daemonReachable = true;
    report.daemon = health.version ?? null;
  }
  if (!report.daemonReachable) {
    return { report, configLoaded: true };
  }
  let serviceToken: string;
  try {
    serviceToken = await loadServiceToken();
  } catch {
    return { report, configLoaded: true };
  }
  const baseUrl = httpBase(
    config.daemon.host,
    config.daemon.port,
    !!config.daemon.tls,
  );
  const auth = { Authorization: `Bearer ${serviceToken}` };
  report.extensions = await fetchComponents(
    `${baseUrl}/v1/extensions`,
    auth,
    "extensions",
  );
  report.transformers = await fetchComponents(
    `${baseUrl}/v1/transformers`,
    auth,
    "transformers",
  );
  return { report, configLoaded: true };
}

async function fetchComponents(
  url: string,
  headers: Record<string, string>,
  key: "extensions" | "transformers",
): Promise<ComponentInfo[]> {
  try {
    const r = await fetch(url, { headers });
    if (!r.ok) {
      return [];
    }
    const body = (await r.json()) as Record<
      string,
      Array<{ name: string; version: string | null; status: string }>
    >;
    const list = body[key];
    if (!Array.isArray(list)) {
      return [];
    }
    return list.map((c) => ({
      name: c.name,
      version: c.version ?? null,
      status: c.status,
    }));
  } catch {
    return [];
  }
}

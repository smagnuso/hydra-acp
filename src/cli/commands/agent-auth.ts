import os from "node:os";
import { spawn } from "node:child_process";
import type { SpawnOptionsWithoutStdio } from "node:child_process";

import { openWs } from "../../shim/open-ws.js";
import { wsToMessageStream } from "../../acp/ws-stream.js";
import { JsonRpcConnection } from "../../acp/connection.js";
import { loadConfig } from "../../core/config.js";
import { resolveLocalTarget } from "../../core/remote-target.js";
import { ensureDaemonReachable } from "../../core/daemon-bootstrap.js";
import { ACP_PROTOCOL_VERSION } from "../../acp/types.js";
import { HYDRA_VERSION } from "../../core/hydra-version.js";
import { AuthMethod } from "../../acp/types-capabilities.js";
import { JsonRpcErrorCodes } from "../../acp/types-jsonrpc.js";
import {
  handleAuthMethodSelection,
  type TerminalAuthPlan,
  type MethodSelectionOutcome,
} from "../../tui/auth-required-banner.js";

// ---- Core logic (testable) -----------------------------------------------

export interface RunAgentAuthCoreDeps {
  conn: JsonRpcConnection;
  agentId: string;
  authMethods: AuthMethod[];
  method?: string;
  spawn: typeof import("node:child_process").spawn;
}

export interface RunAgentAuthCoreResult {
  exitCode: number;
}

export async function runAgentAuthCore({
  conn,
  agentId,
  authMethods,
  method,
  spawn: spawnFn,
}: RunAgentAuthCoreDeps): Promise<RunAgentAuthCoreResult> {
  // Discover the agent's advertised authMethods proactively via the
  // hydra-acp/agents/auth_methods probe. That spawns the agent, runs
  // initialize with our full clientCapabilities (auth.terminal +
  // _meta["terminal-auth"]), and returns whatever methods the agent
  // emits. We then drive the picker on that list — no need to wait for
  // a session/new to throw AUTH_REQUIRED.
  //
  // Falls back to the session/new probe only if the discovery RPC
  // itself fails (older daemon, network blip, etc.); the probe still
  // surfaces AUTH_REQUIRED-on-prompt-time agents that don't advertise
  // methods at initialize.
  let discovered: AuthMethod[] | undefined;
  try {
    const result = (await conn.request("hydra-acp/agents/auth_methods", {
      agentId,
    })) as { authMethods?: AuthMethod[] };
    discovered = Array.isArray(result?.authMethods)
      ? (result.authMethods as AuthMethod[])
      : [];
  } catch {
    discovered = undefined;
  }

  const runTerminalAuth: (
    plan: TerminalAuthPlan,
  ) => Promise<{ exitCode: number | null }> = (plan) => {
    return new Promise<{ exitCode: number | null }>((resolve) => {
      const child = spawnFn(plan.command, plan.args, {
        stdio: "inherit",
        env: plan.env,
        cwd: plan.cwd,
      });
      child.on("exit", (code) => {
        resolve({ exitCode: code });
      });
      child.on("error", () => {
        resolve({ exitCode: -1 });
      });
    });
  };

  const drivePicker = async (
    methods: AuthMethod[],
    resolvedAgentId: string,
  ): Promise<RunAgentAuthCoreResult> => {
    const chosen = await pickAuthMethod(methods, method);
    const outcome = await handleAuthMethodSelection(chosen, {
      authenticate: (methodId) =>
        conn.request("authenticate", {
          methodId,
          _meta: { "hydra-acp": { agentId: resolvedAgentId } },
        }),
      runTerminalAuth,
    });
    if (outcome.kind === "terminal-completed") {
      return { exitCode: 0 };
    }
    if (outcome.kind === "retry") {
      process.stderr.write(
        "auth method completed without terminal step; you may need to retry session/new\n",
      );
      return { exitCode: 0 };
    }
    if (outcome.kind === "error") {
      process.stderr.write(`${outcome.message}\n`);
      return { exitCode: 1 };
    }
    process.stderr.write(
      `auth process exited with code ${outcome.exitCode}\n`,
    );
    return { exitCode: 1 };
  };

  if (discovered !== undefined && discovered.length > 0) {
    return drivePicker(discovered, agentId);
  }

  try {
    await conn.request("session/new", {
      cwd: os.homedir(),
      mcpServers: [],
      _meta: { "hydra-acp": { agentId } },
    });
    process.stdout.write(
      `agent ${agentId} does not currently require authentication\n`,
    );
    return { exitCode: 0 };
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as { code: number }).code === JsonRpcErrorCodes.AuthRequired
    ) {
      const errorData = (
        err as { data?: { _meta?: { "hydra-acp"?: { authMethods?: AuthMethod[]; agentId?: string } } } }
      ).data;
      const methods: AuthMethod[] =
        errorData?._meta?.["hydra-acp"]?.authMethods ?? authMethods;
      const resolvedAgentId: string =
        errorData?._meta?.["hydra-acp"]?.agentId ?? agentId;
      return drivePicker(methods, resolvedAgentId);
    }
    throw err;
  }
}

// ---- Public entry point (WS setup + process.exit) --------------------------

async function pickAuthMethod(
  methods: AuthMethod[],
  flag: string | undefined,
): Promise<AuthMethod> {
  if (flag !== undefined) {
    const found = methods.find((m) => m.id === flag);
    if (found) {
      return found;
    }
    const ids = methods.map((m) => m.id).join(", ");
    process.stderr.write(
      `unknown auth method "${flag}" — valid ids: ${ids}\n`,
    );
    process.exit(2);
  }

  if (methods.length === 1) {
    return methods[0]!;
  }

  if (process.stdin.isTTY === true) {
    const lines = methods.map(
      (m, i) => `${i + 1}) ${m.id} — ${m.name ?? m.description ?? ""}`,
    );
    process.stdout.write(
      `multiple auth methods available. choose one:\n${lines.join("\n")}\n`,
    );
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const raw = await rl.question("method> ");
    rl.close();
    const choice = parseInt(raw.trim(), 10);
    if (Number.isNaN(choice) || choice < 1 || choice > methods.length) {
      process.stderr.write(
        `invalid selection "${raw}" — enter a number between 1 and ${methods.length}\n`,
      );
      process.exit(2);
    }
    return methods[choice - 1]!;
  }

  const ids = methods.map((m) => m.id).join(", ");
  process.stderr.write(
    `multiple auth methods available; pass --method <id> (one of: ${ids})\n`,
  );
  process.exit(2);
}

export async function runAgentAuth(
  agentId: string | undefined,
  flags: Record<string, string | boolean>,
): Promise<void> {
  if (agentId === undefined || agentId.length === 0) {
    process.stderr.write("Usage: hydra agent auth <agent-id>\n");
    process.exit(2);
  }

  const { resolveAgentIdOrExit } = await import("./agents.js");
  const canonicalAgentId = await resolveAgentIdOrExit(agentId, "hydra agent auth");

  const config = await loadConfig();
  const target = await resolveLocalTarget(config);
  await ensureDaemonReachable(config);

  const subprotocols = ["acp.v1", `hydra-acp-token.${target.token}`];
  const ws = await openWs(target.wsUrl, subprotocols);
  const stream = wsToMessageStream(ws);
  const conn = new JsonRpcConnection(stream);

  try {
    await conn.request("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "hydra-cli", version: HYDRA_VERSION },
    });
  } catch {
    // initialize is best-effort on the daemon side; proceed.
  }

  let result: RunAgentAuthCoreResult;
  try {
    result = await runAgentAuthCore({
      conn,
      agentId: canonicalAgentId,
      authMethods: [],
      method: typeof flags["method"] === "string" ? flags["method"] : undefined,
      spawn,
    });
  } finally {
    ws.close();
  }
  process.exit(result.exitCode);
}

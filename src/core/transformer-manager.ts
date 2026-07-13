import {
  ChildSupervisor,
  type BaseChildContext,
  type BaseChildInfo,
  type BaseChildStatus,
  type ChildSupervisorOptions,
  type SupervisorAdapter,
} from "./child-supervisor.js";
import type { TransformerConfig } from "./config.js";
import { paths } from "./paths.js";
import type { JsonRpcConnection } from "../acp/connection.js";

export type TransformerContext = BaseChildContext;
export type TransformerStatus = BaseChildStatus;
export type TransformerInfo = BaseChildInfo;

// A transformer that has completed hydra-acp/transformer/initialize and is ready to
// participate in session chains. Held by TransformerManager and handed to
// Session when the session is created.
export interface TransformerRef {
  name: string;
  intercepts: Set<string>;
  connection: JsonRpcConnection;
}

const TRANSFORMER_ADAPTER: SupervisorAdapter = {
  kind: "transformer",
  nameEnvVar: "HYDRA_ACP_TRANSFORMER_NAME",
  tokenRole: "transformer",
  paths: {
    dir: paths.transformersDir,
    logFile: paths.transformerLogFile,
    pidFile: paths.transformerPidFile,
  },
};

export class TransformerManager extends ChildSupervisor<TransformerConfig> {
  // Transformers that have completed hydra-acp/transformer/initialize and are ready to
  // participate in chains. Keyed by transformer name.
  private connected = new Map<string, TransformerRef>();

  constructor(
    transformers: TransformerConfig[],
    context?: TransformerContext,
    options: ChildSupervisorOptions = {},
  ) {
    super(transformers, TRANSFORMER_ADAPTER, context, options);
  }

  // Called by the WS handler after hydra-acp/transformer/initialize completes. The
  // transformer is now eligible to participate in session chains.
  registerConnection(
    name: string,
    connection: JsonRpcConnection,
    intercepts: string[],
  ): void {
    this.connected.set(name, {
      name,
      connection,
      intercepts: new Set(intercepts),
    });
  }

  // Called by the WS handler when the transformer's WS connection closes.
  deregisterConnection(name: string): void {
    this.connected.delete(name);
  }

  // Resolve a list of transformer names to their live TransformerRef objects.
  // Names that are configured but not yet connected are silently skipped
  // (fail-open: session proceeds without that transformer rather than failing).
  resolveChain(names: string[]): TransformerRef[] {
    const out: TransformerRef[] = [];
    for (const name of names) {
      const ref = this.connected.get(name);
      if (ref) {
        out.push(ref);
      }
    }
    return out;
  }

  // Return every connected transformer whose declared intercepts include
  // `intercept`. Used by broadcast lifecycle signals (session.starting)
  // that fire out-of-chain — the daemon dispatches to any subscribing
  // transformer regardless of whether it's currently in the session's
  // transform chain. Order is registration order (arbitrary but stable).
  interestedIn(intercept: string): TransformerRef[] {
    const out: TransformerRef[] = [];
    for (const ref of this.connected.values()) {
      if (ref.intercepts.has(intercept)) {
        out.push(ref);
      }
    }
    return out;
  }
}

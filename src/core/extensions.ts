import {
  ChildSupervisor,
  type BaseChildContext,
  type BaseChildInfo,
  type BaseChildStatus,
  type ChildSupervisorOptions,
  type SupervisorAdapter,
} from "./child-supervisor.js";
import type { ExtensionConfig } from "./config.js";
import { paths } from "./paths.js";

export type ExtensionContext = BaseChildContext;
export type ExtensionStatus = BaseChildStatus;
export type ExtensionInfo = BaseChildInfo;

const EXTENSION_ADAPTER: SupervisorAdapter = {
  kind: "extension",
  nameEnvVar: "HYDRA_ACP_EXTENSION_NAME",
  tokenRole: "extension",
  paths: {
    dir: paths.extensionsDir,
    logFile: paths.extensionLogFile,
    pidFile: paths.extensionPidFile,
  },
};

export class ExtensionManager extends ChildSupervisor<ExtensionConfig> {
  constructor(
    extensions: ExtensionConfig[],
    context?: ExtensionContext,
    options: ChildSupervisorOptions = {},
  ) {
    super(extensions, EXTENSION_ADAPTER, context, options);
  }
}

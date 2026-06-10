import { createResourceCommands } from "./_resource-commands.js";

const cmds = createResourceCommands("extension");

export const runExtensionsList = cmds.list;
export const runExtensionsAdd = cmds.add;
export const runExtensionsRemove = cmds.remove;
export const runExtensionsStart = cmds.start;
export const runExtensionsStop = cmds.stop;
export const runExtensionsRestart = cmds.restart;
export const runExtensionsLogs = cmds.logs;

import { createResourceCommands } from "./_resource-commands.js";

const cmds = createResourceCommands("transformer");

export const runTransformersList = cmds.list;
export const runTransformersAdd = cmds.add;
export const runTransformersRemove = cmds.remove;
export const runTransformersStart = cmds.start;
export const runTransformersStop = cmds.stop;
export const runTransformersRestart = cmds.restart;
export const runTransformersLogs = cmds.logs;

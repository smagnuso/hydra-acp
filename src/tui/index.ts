// Public entry for the TUI subcommand. Imported dynamically from cli.ts so
// terminal-kit and its dependents only land in process memory when the user
// actually invokes `acp-hydra tui`.

export { runTuiApp as runTui } from "./app.js";
export type { TuiOptions } from "./app.js";

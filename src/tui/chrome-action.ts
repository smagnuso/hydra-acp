// The one vocabulary of "what a click on a piece of chrome does", shared
// by the bars and the sidebar.
//
// It lives in its own module because both surfaces need it and neither
// should import the other: a sidebar row and a sessionbar chunk mean the
// same thing by "choose-model", and they dispatch through the same
// Screen.dispatchBarAction, so the readonly gate and the clipboard/editor
// handling stay in one place. Anything self-contained (copy, open,
// open-session) Screen handles itself; the rest reach the app via
// ScreenOptions.onBarAction.
//
//   "toggle-mode" / "switch-session" / "show-help" / "detach" /
//   "toggle-options" / "rename-session" / "choose-model" / "choose-agent" /
//   "choose-mode"
//     application effects, routed through onBarAction so they go through
//     the same readonly gate as the equivalent hotkey. The three choosers
//     open the modal for that session config dimension; they read the live
//     option list, so the target's own value is not consulted.
//   "copy"  put the value on the clipboard (Screen handles it).
//   "open"  hand the value to tui.openFileCommand (Screen handles it).
//   "open-session"  jump to the session named by the value (Screen handles
//     it via onHydraLinkClick).
//   "none"  inert, but still hoverable-as-plain-text.
export type ChromeAction =
  | "toggle-mode"
  | "switch-session"
  | "show-help"
  | "detach"
  | "toggle-options"
  | "rename-session"
  | "choose-model"
  | "choose-agent"
  | "choose-mode"
  | "copy"
  | "open"
  | "open-session"
  | "none";

export const CHROME_ACTIONS: readonly ChromeAction[] = [
  "toggle-mode",
  "switch-session",
  "show-help",
  "detach",
  "toggle-options",
  "rename-session",
  "choose-model",
  "choose-agent",
  "choose-mode",
  "copy",
  "open",
  "open-session",
  "none",
];

// A named intent plus its payload, as a clickable target carries it.
export interface ChromeActionTarget {
  action: ChromeAction;
  // Defaults to the target's own text where that makes sense (a bar chunk
  // copies what it shows); required here because a sidebar row's text is
  // an abbreviated label, never the thing to act on.
  value: string;
}

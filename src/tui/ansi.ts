// Centralized ANSI/CSI/DEC escape sequences emitted by the TUI.
//
// Every raw `\x1b[...]` literal written to stdout from screen.ts,
// picker.ts, prompt-utils.ts, sync.ts (and friends) lives here. Touching
// terminal mode bytes in more than one place is a drift hazard — the
// enable/disable pairs must stay symmetric, and several reset paths
// (screen teardown, picker entry, prompt-utils resetTerminalModes) need
// to agree on the same shut-down sequence.

// Bracketed paste mode (DECSET 2004). When on, terminals wrap pasted
// text in \x1b[200~ … \x1b[201~ so the app can distinguish typed input
// from a paste.
export const BRACKETED_PASTE_ON = "\x1b[?2004h";
export const BRACKETED_PASTE_OFF = "\x1b[?2004l";
export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";

// Alternate screen buffer (DECSET 1049). xterm composite that saves the
// cursor, switches to the alt buffer, and clears it; the off form
// reverses all three.
export const ALT_SCREEN_ENTER = "\x1b[?1049h";
export const ALT_SCREEN_LEAVE = "\x1b[?1049l";

// DECAWM auto-wrap. We turn it off while rendering frames that own
// their own line breaks and want to keep the cursor on the last column.
export const AUTOWRAP_ON = "\x1b[?7h";
export const AUTOWRAP_OFF = "\x1b[?7l";

// Cursor visibility (DECTCEM).
export const SHOW_CURSOR = "\x1b[?25h";

// DECCKM (cursor-key mode) off — make arrows emit CSI A/B/C/D rather
// than SS3 OA/OB/OC/OD. terminal-kit's osx-256color keymap only
// recognizes the CSI form, so iTerm under the alt screen needs this.
export const DECCKM_OFF = "\x1b[?1l";

// DECPAM (application keypad mode) off — counterpart to DECCKM_OFF,
// used by the picker entry reset.
export const DECPAM_OFF = "\x1b>";

// Kitty keyboard protocol stack. Push a flag set that enables
// disambiguating escape codes (Shift+Enter becomes \x1b[13;2u, etc.);
// pop to restore whatever the host shell had.
export const KITTY_KBD_PUSH = "\x1b[>1u";
export const KITTY_KBD_POP = "\x1b[<u";

// xterm modifyOtherKeys / formatOtherKeys. ON variants put xterm into
// the CSI-27 modifyOtherKeys form (\x1b[27;<mod>;<code>~) so we receive
// modified keys that would otherwise be eaten by the terminal. OFF
// variants restore default behavior.
export const MODIFY_OTHER_KEYS_ON = "\x1b[>4;2m";
export const MODIFY_OTHER_KEYS_OFF = "\x1b[>4;0m";
export const FORMAT_OTHER_KEYS_ON = "\x1b[>5;1m";
export const FORMAT_OTHER_KEYS_OFF = "\x1b[>5;0m";

// Mouse reporting modes. We enable SGR mouse mode (1006) plus button
// or any-motion tracking elsewhere; these are the disable counterparts
// used by every teardown path.
export const MOUSE_X10_OFF = "\x1b[?1000l";
export const MOUSE_BUTTON_OFF = "\x1b[?1002l";
export const MOUSE_ANY_MOTION_OFF = "\x1b[?1003l";
export const MOUSE_SGR_OFF = "\x1b[?1006l";
export const MOUSE_URXVT_OFF = "\x1b[?1015l";

// MasterBandit "selective mouse reporting" (custom CSI = sequences):
// `?w` probes which event mask the terminal supports, `=24;1w` enables
// wheel-only reporting, `=0;0w` disables it.
export const SELECTIVE_MOUSE_PROBE = "\x1b[?w";
export const SELECTIVE_MOUSE_WHEEL_ONLY = "\x1b[=24;1w";
export const SELECTIVE_MOUSE_OFF = "\x1b[=0;0w";

// xterm pointer-shape control (OSC 22). When the pointer hovers a
// clickable region we ask the terminal to swap to its "pointer"
// (hand) shape, and reset to "default" on leave. Honored by xterm,
// kitty, wezterm, ghostty, foot; silently ignored by alacritty,
// iTerm2, Windows Terminal — no fallback needed (the request is
// inherently best-effort). Values mirror CSS cursor names.
export const POINTER_SHAPE_POINTER = "\x1b]22;pointer\x07";
export const POINTER_SHAPE_DEFAULT = "\x1b]22;default\x07";

// Synchronized output (DECSET 2026) — coalesces a burst of writes into
// a single repaint on supporting terminals.
export const SYNC_BEGIN = "\x1b[?2026h";
export const SYNC_END = "\x1b[?2026l";

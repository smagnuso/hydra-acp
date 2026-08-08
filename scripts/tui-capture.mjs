#!/usr/bin/env node
/**
 * TUI capture — render a terminal program headlessly and photograph it.
 *
 * Two uses:
 *   1. Debugging. Drive the TUI to a state, capture what it actually painted,
 *      and look at the bytes or the picture instead of describing it.
 *   2. README/docs assets. The SVG is text, so it diffs in git, stays crisp,
 *      and needs no binary blob.
 *
 * Pipeline: tmux renders the program at a fixed grid, `capture-pane -e` reads
 * the screen back with SGR intact, and the converter turns styled runs into
 * absolutely-positioned <text> (plus <rect> for backgrounds).
 *
 * Usage:
 *   node scripts/tui-capture.mjs --out shot.svg -- hydra-acp tui --session ID --readonly
 *   node scripts/tui-capture.mjs --keys 'C-p' --wait 2000 --out picker.svg -- hydra-acp tui
 *   node scripts/tui-capture.mjs --from capture.ansi --out shot.svg
 *   node scripts/tui-capture.mjs --ansi raw.txt --out shot.svg -- some-program
 *
 * Interactive: run hydra in your own tmux, drive it by hand, then grab the
 * pane as it stands right now from a second terminal. Repeat as often as you
 * like; the pane is only read, never disturbed.
 *   tmux new -s hydra 'hydra-acp tui'          # terminal 1, interact normally
 *   node scripts/tui-capture.mjs --list-panes  # terminal 2, find the target
 *   node scripts/tui-capture.mjs --pane hydra --out shot.svg
 *
 * Recording: same idea, but sampled over time into one animated SVG.
 *   node scripts/tui-capture.mjs --record --pane hydra --duration 15 --out demo.svg
 *
 * Options:
 *   --cols N        grid width  (default 100)
 *   --rows N        grid height (default 30)
 *   --wait MS       settle time before capturing (default 1500)
 *   --keys SPEC     tmux send-keys before capturing; repeatable, ';'-separated.
 *                   e.g. --keys 'C-p' --keys 'hello:Enter'  ("x:Enter" types x
 *                   then presses Enter). Each is followed by --key-wait ms.
 *   --key-wait MS   pause after each --keys step (default 400)
 *   --delay S       count down S seconds before the first grab, in every mode.
 *                   Time to switch windows and get the screen into position.
 *   --tty DEV       capture the tmux pane on this tty, e.g. --tty /dev/pts/5.
 *                   Resolves through tmux; a terminal outside tmux has no
 *                   readable screen buffer and cannot be captured at all.
 *   --pane TARGET   capture a pane you are already driving instead of spawning
 *                   one: a session name, "sess:win.pane", or a "%N" pane id.
 *                   Read-only unless you also pass --keys.
 *   --record        poll the pane and emit an animated SVG instead of a still.
 *                   Needs --pane or --tty. A flipbook: anything between two
 *                   samples is never seen.
 *   --fps N         record sample rate (default 6)
 *   --duration S    record length in seconds. Omitted or 0 records until ^C,
 *                   which stops cleanly and writes the frames collected.
 *   --list-panes    print every live pane with its id, size, and command
 *   --scrollback N  include N lines above the visible screen. Only meaningful
 *                   for normal-screen programs; a full-screen TUI keeps no
 *                   scrollback of its own.
 *   --from FILE     convert an existing ANSI capture; skips tmux entirely
 *   --ansi FILE     also write the raw ANSI capture next to the SVG
 *   --out FILE      SVG destination (default stdout)
 *   --font-size N   default 14
 *   --bg COLOR      default #1d1f21 ("none" for transparent)
 *   --fg COLOR      default foreground, default #d3d7cf
 *   --no-radius     square corners
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

// ---- SGR → style ---------------------------------------------------------

// xterm's first 16. Everything above is generated (cube + grayscale ramp).
const BASE16 = [
  "#2e3436", "#cc0000", "#4e9a06", "#c4a000", "#3465a4", "#75507b", "#06989a", "#d3d7cf",
  "#555753", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec",
];

const hex = (n) => n.toString(16).padStart(2, "0");
const rgbHex = (r, g, b) => `#${hex(r)}${hex(g)}${hex(b)}`;

function xterm256(n) {
  if (n < 16) {
    return BASE16[n];
  }
  if (n < 232) {
    const i = n - 16;
    const level = (v) => (v === 0 ? 0 : 55 + v * 40);
    return rgbHex(level(Math.floor(i / 36) % 6), level(Math.floor(i / 6) % 6), level(i % 6));
  }
  const v = 8 + (n - 232) * 10;
  return rgbHex(v, v, v);
}

function blankStyle() {
  return { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, reverse: false };
}

// Applies one SGR parameter list to `st` in place. Handles 16-colour, 256
// (38;5;n) and truecolor (38;2;r;g;b) in both fg and bg positions.
function applySgr(st, params) {
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (p === 0) {
      Object.assign(st, blankStyle());
    } else if (p === 1) {
      st.bold = true;
    } else if (p === 2) {
      st.dim = true;
    } else if (p === 3) {
      st.italic = true;
    } else if (p === 4) {
      st.underline = true;
    } else if (p === 7) {
      st.reverse = true;
    } else if (p === 22) {
      st.bold = false;
      st.dim = false;
    } else if (p === 23) {
      st.italic = false;
    } else if (p === 24) {
      st.underline = false;
    } else if (p === 27) {
      st.reverse = false;
    } else if (p >= 30 && p <= 37) {
      st.fg = BASE16[p - 30];
    } else if (p >= 90 && p <= 97) {
      st.fg = BASE16[p - 90 + 8];
    } else if (p >= 40 && p <= 47) {
      st.bg = BASE16[p - 40];
    } else if (p >= 100 && p <= 107) {
      st.bg = BASE16[p - 100 + 8];
    } else if (p === 39) {
      st.fg = null;
    } else if (p === 49) {
      st.bg = null;
    } else if (p === 38 || p === 48) {
      const target = p === 38 ? "fg" : "bg";
      const mode = params[i + 1];
      if (mode === 5) {
        st[target] = xterm256(params[i + 2] ?? 0);
        i += 2;
      } else if (mode === 2) {
        st[target] = rgbHex(params[i + 2] ?? 0, params[i + 3] ?? 0, params[i + 4] ?? 0);
        i += 4;
      }
    }
  }
}

// Terminal cells are 1 or 2 columns wide. Getting this wrong shifts every run
// to the right of a wide glyph, so advance by 2 for the ranges that matter.
function charWidth(ch) {
  const cp = ch.codePointAt(0);
  if (cp === undefined) {
    return 1;
  }
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff)
  ) {
    return 2;
  }
  return 0x0300 <= cp && cp <= 0x036f ? 0 : 1;
}

// One screen row → cells, each tagged with its column and resolved style.
function parseRow(line) {
  const st = blankStyle();
  const cells = [];
  let col = 0;
  const re = /\x1b\[([0-9;:]*)m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][A-Za-z0-9]|\x1b./gy;
  let i = 0;
  while (i < line.length) {
    re.lastIndex = i;
    const m = re.exec(line);
    if (m && m.index === i) {
      if (m[1] !== undefined) {
        const params = m[1] === "" ? [0] : m[1].split(/[;:]/).map((x) => (x === "" ? 0 : Number(x)));
        applySgr(st, params);
      }
      i = re.lastIndex;
      continue;
    }
    const ch = String.fromCodePoint(line.codePointAt(i));
    const w = charWidth(ch);
    if (w > 0) {
      cells.push({ ch, col, w, style: { ...st } });
    }
    col += w;
    i += ch.length;
  }
  return cells;
}

// ---- SVG -----------------------------------------------------------------

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function metrics(opt) {
  return {
    cw: opt.fontSize * 0.6,
    lh: Math.round(opt.fontSize * 1.32 * 10) / 10,
    pad: Math.round(opt.fontSize * 0.6),
  };
}

// Renders one frame's <rect>/<text> elements. Returned without a wrapper so
// the animated path can stack many frames inside one <svg>.
function renderBody(ansi, opt) {
  const rows = ansi.replace(/\n$/, "").split("\n").map(parseRow);
  const { cw, lh, pad } = metrics(opt);
  const cols = rows.reduce((m, r) => Math.max(m, r.length ? r[r.length - 1].col + r[r.length - 1].w : 0), 0);
  const out = [];
  // Backgrounds first so text always paints over them.
  const bgOf = (s) => (s.reverse ? (s.fg ?? opt.fg) : s.bg);
  const fgOf = (s) => (s.reverse ? (s.bg ?? opt.bg) : (s.fg ?? opt.fg));

  rows.forEach((cells, r) => {
    const y = pad + r * lh;
    for (let i = 0; i < cells.length; ) {
      const bg = bgOf(cells[i].style);
      let j = i;
      let width = 0;
      while (j < cells.length && bgOf(cells[j].style) === bg && cells[j].col === cells[i].col + width) {
        width += cells[j].w;
        j++;
      }
      if (bg && bg !== "none") {
        out.push(
          `<rect x="${(pad + cells[i].col * cw).toFixed(1)}" y="${y.toFixed(1)}" ` +
            `width="${(width * cw).toFixed(1)}" height="${lh.toFixed(1)}" fill="${bg}"/>`,
        );
      }
      i = j;
    }
  });

  rows.forEach((cells, r) => {
    const baseline = pad + r * lh + opt.fontSize * 0.8;
    const key = (s) =>
      `${fgOf(s)}|${s.bold}|${s.dim}|${s.italic}|${s.underline}`;
    for (let i = 0; i < cells.length; ) {
      let j = i;
      while (j < cells.length && key(cells[j].style) === key(cells[i].style) && cells[j].col === cells[i].col + (j - i)) {
        j++;
      }
      const text = cells.slice(i, j).map((c) => c.ch).join("");
      const s = cells[i].style;
      if (text.trim() !== "") {
        const attrs = [
          `x="${(pad + cells[i].col * cw).toFixed(1)}"`,
          `y="${baseline.toFixed(1)}"`,
          `fill="${fgOf(s)}"`,
          s.bold ? 'font-weight="bold"' : "",
          s.italic ? 'font-style="italic"' : "",
          s.underline ? 'text-decoration="underline"' : "",
          s.dim ? 'fill-opacity="0.6"' : "",
          'xml:space="preserve"',
        ].filter(Boolean);
        out.push(`<text ${attrs.join(" ")}>${esc(text)}</text>`);
      }
      i = j;
    }
  });

  return { body: out.join("\n"), cols, rowCount: rows.length };
}

function svgOpen(cols, rowCount, opt) {
  const { cw, lh, pad } = metrics(opt);
  const W = Math.ceil(cols * cw + pad * 2);
  const H = Math.ceil(rowCount * lh + pad * 2);
  const head =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" ` +
    `font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,'DejaVu Sans Mono',monospace" ` +
    `font-size="${opt.fontSize}">`;
  const bg =
    opt.bg === "none"
      ? ""
      : `\n<rect width="100%" height="100%" fill="${opt.bg}"${opt.radius ? ' rx="6"' : ""}/>`;
  return head + bg;
}

function toSvg(ansi, opt) {
  const { body, cols, rowCount } = renderBody(ansi, opt);
  return `${svgOpen(cols, rowCount, opt)}\n${body}\n</svg>\n`;
}

// Frames are stacked as sibling <g>s, all hidden except during their slice of
// one shared CSS animation. This animates in an <img> context, which is how
// GitHub renders an SVG referenced from markdown; scripting would not.
function toAnimatedSvg(frames, opt) {
  const rendered = frames.map((f) => ({ ...f, ...renderBody(f.ansi, opt) }));
  const cols = rendered.reduce((m, f) => Math.max(m, f.cols), 0);
  const rowCount = rendered.reduce((m, f) => Math.max(m, f.rowCount), 0);
  const total = rendered.reduce((t, f) => t + f.dur, 0) / 1000;

  const css = [];
  const groups = [];
  let at = 0;
  rendered.forEach((f, i) => {
    const from = (at / total) * 100;
    at += f.dur / 1000;
    const to = (at / total) * 100;
    const p = (v) => Math.max(0, Math.min(100, v)).toFixed(4);
    // Hard cuts: hold 0, flip to 1 for the slice, flip back. The tiny epsilon
    // keeps adjacent stops from being coalesced into a crossfade.
    const stops =
      i === 0
        ? `0%,${p(to)}%{opacity:1}${p(to + 0.0001)}%,100%{opacity:0}`
        : `0%,${p(from)}%{opacity:0}${p(from + 0.0001)}%,${p(to)}%{opacity:1}${p(to + 0.0001)}%,100%{opacity:0}`;
    css.push(`@keyframes k${i}{${stops}}`);
    css.push(`#f${i}{opacity:0;animation:k${i} ${total.toFixed(3)}s infinite}`);
    groups.push(`<g id="f${i}">\n${f.body}\n</g>`);
  });

  return [
    svgOpen(cols, rowCount, opt),
    `<style>${css.join("")}</style>`,
    groups.join("\n"),
    "</svg>",
    "",
  ].join("\n");
}

// ---- tmux ----------------------------------------------------------------

function tmux(args, { check = true } = {}) {
  const r = spawnSync("tmux", args, { encoding: "utf8" });
  if (check && r.status !== 0) {
    throw new Error(`tmux ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout ?? "";
}

// Synchronous sleep with no process spawn. The recorder calls this every
// frame, so shelling out would add more jitter than the interval it is
// trying to hold.
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms) => {
  if (ms > 0) {
    Atomics.wait(SLEEP_BUF, 0, 0, ms);
  }
};

// Resolve /dev/pts/N to the tmux pane driving it. Only tmux panes are
// findable: a pty has no screen buffer of its own, the grid lives in whatever
// emulator owns it, so a tty outside tmux cannot be photographed at all.
// Gives you time to switch windows and get the screen into position before
// anything is grabbed. Synchronous on purpose: nothing has been captured yet,
// so there is no partial result a ^C would need to preserve.
function countdown(seconds) {
  if (!(seconds > 0)) {
    return;
  }
  const tty = process.stderr.isTTY;
  for (let left = Math.ceil(seconds); left > 0; left--) {
    process.stderr.write(tty ? `\rstarting in ${left}s... ` : `starting in ${left}s\n`);
    sleep(1000);
  }
  process.stderr.write(tty ? "\r                      \r" : "");
}

function paneForTty(tty) {
  const want = tty.startsWith("/dev/") ? tty : `/dev/${tty}`;
  const rows = tmux(["list-panes", "-a", "-F", "#{pane_tty}\t#{pane_id}"])
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("\t"));
  const hit = rows.find(([t]) => t === want);
  if (!hit) {
    throw new Error(
      `no tmux pane on ${want}. Only panes can be captured — a terminal ` +
        `outside tmux keeps its screen in the emulator, where nothing can read ` +
        `it. Run --list-panes to see what is available.`,
    );
  }
  return hit[1];
}

function capturePane(target, opt) {
  countdown(opt.delay);
  const args = ["capture-pane", "-p", "-e", "-t", target];
  if (opt.scrollback > 0) {
    args.push("-S", String(-opt.scrollback));
  }
  for (const spec of opt.keys) {
    sendKeys(target, spec, opt);
  }
  return tmux(args);
}

// Polls the pane on a timer and keeps a frame whenever the screen actually
// changed. This is a flipbook, not a recording: anything that happens between
// two samples is never seen. Frame durations come from measured wall clock, so
// a slow capture stretches that frame rather than desyncing playback.
async function recordPane(target, opt) {
  const interval = Math.max(1, Math.round(1000 / opt.fps));
  const frames = [];
  let prev = null;
  let stopping = false;

  // The loop must yield for this to ever fire, which is why it awaits rather
  // than blocking on Atomics.wait like the rest of the script. Stopping is
  // cooperative so the frames collected so far still get written.
  const onSigint = () => {
    stopping = true;
  };
  process.on("SIGINT", onSigint);

  countdown(opt.delay);
  process.stderr.write(
    `recording ${target} at ${opt.fps}fps ` +
      `${opt.duration > 0 ? `for ${opt.duration}s` : "until ^C"} (^C stops and writes)\n`,
  );
  // Clock starts after the countdown, not before it, so --duration always
  // means "record for this long" rather than "this long minus the delay".
  let prevAt = Date.now();
  const deadline = opt.duration > 0 ? prevAt + opt.duration * 1000 : Infinity;
  try {
    while (!stopping && Date.now() < deadline) {
      const started = Date.now();
      const ansi = tmux(["capture-pane", "-p", "-e", "-t", target]);
      if (prev === null) {
        prev = ansi;
        prevAt = started;
      } else if (ansi !== prev) {
        frames.push({ ansi: prev, dur: started - prevAt });
        prev = ansi;
        prevAt = started;
      }
      const rest = interval - (Date.now() - started);
      if (rest > 0) {
        await new Promise((r) => setTimeout(r, rest));
      }
    }
  } finally {
    process.off("SIGINT", onSigint);
  }
  if (prev !== null) {
    frames.push({ ansi: prev, dur: Math.max(interval, Date.now() - prevAt) });
  }
  process.stderr.write(`${frames.length} distinct frames\n`);
  return frames;
}

function sendKeys(target, spec, opt) {
  for (const step of spec.split(";")) {
    const parts = step.split(":");
    const literal = parts.slice(0, -1).join(":");
    const key = parts.length > 1 ? parts[parts.length - 1] : step;
    if (parts.length > 1 && literal !== "") {
      tmux(["send-keys", "-t", target, "-l", literal]);
    }
    tmux(["send-keys", "-t", target, key]);
    sleep(opt.keyWait);
  }
}

function captureViaTmux(command, opt) {
  const session = `hydracap_${process.pid}`;
  tmux(["kill-session", "-t", session], { check: false });
  tmux([
    "new-session", "-d", "-s", session,
    "-x", String(opt.cols), "-y", String(opt.rows),
    `${command}; printf '\\n[exited %s]' "$?"; sleep 600`,
  ]);
  try {
    sleep(opt.wait);
    for (const spec of opt.keys) {
      sendKeys(session, spec, opt);
    }
    countdown(opt.delay);
    return tmux(["capture-pane", "-p", "-e", "-t", session]);
  } finally {
    tmux(["kill-session", "-t", session], { check: false });
  }
}

// ---- main ----------------------------------------------------------------

async function main(argv) {
  const opt = {
    cols: 100, rows: 30, wait: 1500, keyWait: 400, keys: [],
    from: null, ansiOut: null, out: null, pane: null, tty: null, scrollback: 0,
    record: false, fps: 6, duration: 0, delay: 0,
    fontSize: 14, bg: "#1d1f21", fg: "#d3d7cf", radius: true,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    } else if (a === "--cols") {
      opt.cols = Number(argv[++i]);
    } else if (a === "--rows") {
      opt.rows = Number(argv[++i]);
    } else if (a === "--wait") {
      opt.wait = Number(argv[++i]);
    } else if (a === "--key-wait") {
      opt.keyWait = Number(argv[++i]);
    } else if (a === "--keys") {
      opt.keys.push(argv[++i]);
    } else if (a === "--pane") {
      opt.pane = argv[++i];
    } else if (a === "--tty") {
      opt.tty = argv[++i];
    } else if (a === "--delay") {
      opt.delay = Number(argv[++i]);
    } else if (a === "--record") {
      opt.record = true;
    } else if (a === "--fps") {
      opt.fps = Number(argv[++i]);
    } else if (a === "--duration") {
      opt.duration = Number(argv[++i]);
    } else if (a === "--scrollback") {
      opt.scrollback = Number(argv[++i]);
    } else if (a === "--list-panes") {
      process.stdout.write(
        tmux([
          "list-panes", "-a", "-F",
          "#{pane_id}\t#{session_name}:#{window_index}.#{pane_index}\t" +
            "#{pane_width}x#{pane_height}\t#{pane_current_command}",
        ]),
      );
      return 0;
    } else if (a === "--from") {
      opt.from = argv[++i];
    } else if (a === "--ansi") {
      opt.ansiOut = argv[++i];
    } else if (a === "--out") {
      opt.out = argv[++i];
    } else if (a === "--font-size") {
      opt.fontSize = Number(argv[++i]);
    } else if (a === "--bg") {
      opt.bg = argv[++i];
    } else if (a === "--fg") {
      opt.fg = argv[++i];
    } else if (a === "--no-radius") {
      opt.radius = false;
    } else if (a === "-h" || a === "--help") {
      process.stdout.write(readFileSync(new URL(import.meta.url)).toString().split("*/")[0] + "*/\n");
      return 0;
    } else {
      throw new Error(`unknown option: ${a}`);
    }
  }

  if (opt.record) {
    const target = opt.tty ? paneForTty(opt.tty) : opt.pane;
    if (!target) {
      throw new Error("--record needs --pane <target> or --tty <dev>");
    }
    const frames = await recordPane(target, opt);
    if (frames.length === 0) {
      throw new Error("captured no frames");
    }
    const svg = toAnimatedSvg(frames, opt);
    if (opt.out) {
      writeFileSync(opt.out, svg);
      process.stderr.write(`wrote ${opt.out} (${svg.length} bytes)\n`);
    } else {
      process.stdout.write(svg);
    }
    return 0;
  }

  let ansi;
  if (opt.from) {
    ansi = readFileSync(opt.from, "utf8");
  } else if (opt.pane || opt.tty) {
    ansi = capturePane(opt.tty ? paneForTty(opt.tty) : opt.pane, opt);
  } else if (rest.length > 0) {
    ansi = captureViaTmux(rest.join(" "), opt);
  } else {
    throw new Error(
      "nothing to capture: pass --pane <target>, --tty <dev>, --from <file>, or -- <command...>",
    );
  }

  if (opt.ansiOut) {
    writeFileSync(opt.ansiOut, ansi);
  }
  const svg = toSvg(ansi, opt);
  if (opt.out) {
    writeFileSync(opt.out, svg);
    process.stderr.write(`wrote ${opt.out} (${svg.length} bytes)\n`);
  } else {
    process.stdout.write(svg);
  }
  return 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`tui-capture: ${err.message}\n`);
    process.exit(1);
  });

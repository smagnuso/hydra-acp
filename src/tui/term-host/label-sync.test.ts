import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setTerminalHost, __resetTerminalHostForTests } from "./index.js";
import {
  __resetLabelSyncForTests,
  mayRenameTab,
  restoreTabLabel,
  syncTabLabel,
  TRANSIENT_TAB_LABEL,
} from "./label-sync.js";
import type { TabLabelView, TerminalHost } from "./types.js";

// A fake host instead of a fake socket. This is the payoff of the refactor:
// the policy under test never had anything to do with a transport, and now
// the tests say so.
interface Call {
  method: string;
  label?: string;
}
let sent: Call[];
let tab: TabLabelView | null;
let readThrows: Error | null;
let writeOk: boolean;
let canLabel: boolean;
// One plausible convention (numeric = auto), kept as the fixture because the
// numeric-vs-named distinction is what the guard turns on. A tmux adapter
// would answer differently and none of the policy below would change.
const isAutoLabel = (label: string): boolean =>
  label.trim().length === 0 || /^[0-9]+$/.test(label.trim());

function fakeHost(): TerminalHost {
  return {
    id: "fake",
    get caps() {
      return { openTab: true, split: false, label: canLabel, report: true };
    },
    report: () => Promise.resolve(),
    release: () => Promise.resolve(),
    readLabel: () => {
      sent.push({ method: "readLabel" });
      if (readThrows) {
        return Promise.reject(readThrows);
      }
      return Promise.resolve(tab);
    },
    writeLabel: (label: string) => {
      sent.push({ method: "writeLabel", label });
      return Promise.resolve(writeOk);
    },
    isAutoLabel,
  };
}

function tabGet(label: string, paneCount = 1): TabLabelView {
  return { label, paneCount };
}

// syncTabLabel is fire-and-forget; let its chain settle.
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

function renames(): string[] {
  return sent
    .filter((s) => s.method === "writeLabel")
    .map((s) => s.label as string);
}

beforeEach(() => {
  sent = [];
  tab = tabGet("1");
  readThrows = null;
  writeOk = true;
  canLabel = true;
  __resetLabelSyncForTests();
  setTerminalHost(fakeHost());
});

afterEach(() => {
  __resetTerminalHostForTests();
  __resetLabelSyncForTests();
  delete process.env.HYDRA_TAB_LABEL;
});

describe("the adapter-supplied isAutoLabel predicate", () => {
  it("treats a numeric default as auto-generated", () => {
    expect(isAutoLabel("1")).toBe(true);
    expect(isAutoLabel("12")).toBe(true);
  });

  it("treats an empty label as auto-generated", () => {
    expect(isAutoLabel("")).toBe(true);
    expect(isAutoLabel("   ")).toBe(true);
  });

  it("treats anything a human would type as owned", () => {
    expect(isAutoLabel("review")).toBe(false);
    expect(isAutoLabel("tab 2")).toBe(false);
    // Not numeric-only: a session titled "2fa" is still a real name.
    expect(isAutoLabel("2fa")).toBe(false);
  });
});

describe("mayRenameTab", () => {
  it("refuses a split tab even when the label is auto-generated", () => {
    expect(mayRenameTab("1", 2, isAutoLabel)).toBe(false);
  });

  it("allows a single-pane tab with an auto label", () => {
    expect(mayRenameTab("1", 1, isAutoLabel)).toBe(true);
  });

  it("refuses a label the user chose", () => {
    expect(mayRenameTab("review", 1, isAutoLabel)).toBe(false);
  });
});

describe("syncTabLabel", () => {
  it("renames a freshly auto-labelled tab", async () => {
    syncTabLabel("fix the parser");
    await settle();
    expect(sent[0]?.method).toBe("readLabel");
    expect(sent[1]).toEqual({ method: "writeLabel", label: "fix the parser" });
  });

  it("keeps following the title after its own rename", async () => {
    syncTabLabel("first");
    await settle();
    // The tab now reports OUR label, which is not auto-generated. Without
    // tracking what we wrote, guard (1) would lock us out after one write.
    tab = tabGet("first");
    syncTabLabel("second");
    await settle();
    expect(renames()).toEqual(["first", "second"]);
  });

  it("does not stomp a label the user set", async () => {
    tab = tabGet("my tab");
    syncTabLabel("session title");
    await settle();
    expect(renames()).toEqual([]);
  });

  it("backs off permanently once the user renames over us", async () => {
    syncTabLabel("ours");
    await settle();
    tab = tabGet("theirs");
    syncTabLabel("ours again");
    await settle();
    expect(renames()).toEqual(["ours"]);
  });

  it("does not name a split tab", async () => {
    tab = tabGet("1", 2);
    syncTabLabel("session title");
    await settle();
    expect(renames()).toEqual([]);
  });

  it("re-checks the guards on every title change, not once", async () => {
    syncTabLabel("first");
    await settle();
    // User splits the tab mid-session.
    tab = tabGet("first", 2);
    syncTabLabel("second");
    await settle();
    expect(renames()).toEqual(["first"]);
  });

  it("skips a redundant write when the title has not changed", async () => {
    syncTabLabel("same");
    await settle();
    tab = tabGet("same");
    syncTabLabel("same");
    await settle();
    expect(renames()).toEqual(["same"]);
    expect(sent.filter((s) => s.method === "readLabel")).toHaveLength(1);
  });

  it("coalesces titles that arrive during a round trip, dropping the intermediates", async () => {
    syncTabLabel("a");
    syncTabLabel("b");
    syncTabLabel("c");
    await settle();
    // "a" was already in flight when "b" and "c" arrived, so it lands.
    // "b" is discarded — only the newest pending title is ever written,
    // which is what keeps a fast series of title updates from becoming a
    // series of round trips.
    expect(renames()).toEqual(["a", "c"]);
  });

  it("is inert when the host can't do labels", async () => {
    // Not "best effort": a host that can't read the label back can't run
    // the ownership guard, so writing would stomp the user's own name.
    canLabel = false;
    syncTabLabel("title");
    await settle();
    expect(sent).toEqual([]);
  });

  it("is inert with no host at all", async () => {
    setTerminalHost(null);
    syncTabLabel("title");
    await settle();
    expect(sent).toEqual([]);
  });

  it("ignores an empty title rather than blanking the tab", async () => {
    syncTabLabel("");
    syncTabLabel(null);
    syncTabLabel(undefined);
    await settle();
    expect(sent).toEqual([]);
  });

  it("survives a failing tab.get", async () => {
    readThrows = new Error("host unreachable");
    syncTabLabel("title");
    await settle();
    expect(renames()).toEqual([]);
  });

  it("does not record a failed rename as applied", async () => {
    writeOk = false;
    syncTabLabel("title");
    await settle();
    writeOk = true;
    syncTabLabel("title");
    await settle();
    expect(renames()).toEqual(["title", "title"]);
  });
});

describe("restoreTabLabel", () => {
  it("puts the original auto label back", async () => {
    syncTabLabel("session title");
    await settle();
    sent = [];
    tab = tabGet("session title");
    await restoreTabLabel();
    expect(renames()).toEqual(["1"]);
  });

  it("does nothing when we never renamed", async () => {
    tab = tabGet("user label");
    syncTabLabel("session title");
    await settle();
    sent = [];
    await restoreTabLabel();
    expect(sent).toEqual([]);
  });

  it("leaves a label the user set after us alone", async () => {
    syncTabLabel("session title");
    await settle();
    sent = [];
    tab = tabGet("user renamed it");
    await restoreTabLabel();
    expect(renames()).toEqual([]);
  });

  it("restores the label we found, not the tab number, when the tab was named on creation", async () => {
    // ^t-created tabs come up labelled with the session title already.
    tab = tabGet("3");
    syncTabLabel("a");
    await settle();
    tab = tabGet("a");
    syncTabLabel("b");
    await settle();
    sent = [];
    tab = tabGet("b");
    await restoreTabLabel();
    expect(renames()).toEqual(["3"]);
  });

  it("is idempotent", async () => {
    syncTabLabel("session title");
    await settle();
    tab = tabGet("session title");
    await restoreTabLabel();
    sent = [];
    await restoreTabLabel();
    expect(sent).toEqual([]);
  });
});

// A ^t-created tab arrives already labelled by the hydra that created it,
// which is a different process. Without an ownership hand-off, guard (1)
// mistakes our own label for a human's and the tab never follows the
// title — the exact case where following it matters most.
describe("ownership adopted from the creating process", () => {
  afterEach(() => {
    delete process.env.HYDRA_TAB_LABEL;
  });

  it("renames a tab we created, despite the label not being auto-generated", async () => {
    process.env.HYDRA_TAB_LABEL = "fix the parser";
    tab = tabGet("fix the parser");
    syncTabLabel("Parser rewrite");
    await settle();
    expect(renames()).toEqual(["Parser rewrite"]);
  });

  it("does not adopt when the user has renamed the tab since it was created", async () => {
    process.env.HYDRA_TAB_LABEL = "fix the parser";
    tab = tabGet("mine now");
    syncTabLabel("Parser rewrite");
    await settle();
    expect(renames()).toEqual([]);
  });

  // A process killed with the picker up (crash, or a restart onto a new
  // build) leaves the tab holding the transient label. restoreTabLabel
  // never ran, so nothing put the real one back.
  it("reclaims a transient label left behind by a process that died in the picker", async () => {
    tab = tabGet(TRANSIENT_TAB_LABEL);
    syncTabLabel("Parser rewrite");
    await settle();
    expect(renames()).toEqual(["Parser rewrite"]);
  });

  it("does not reclaim a tab the user named, even something hydra-ish", async () => {
    // The old transient label was literally "hydra", which is also a name
    // a human would pick — indistinguishable, so hydra bricked such tabs.
    // The marker exists so this case stays the user's.
    tab = tabGet("hydra");
    syncTabLabel("Parser rewrite");
    await settle();
    expect(renames()).toEqual([]);
  });

  it("does not put a reclaimed transient label back on exit", async () => {
    // `original` would otherwise capture the marker as the label to
    // restore, leaving the tab named after the picker forever.
    tab = tabGet(TRANSIENT_TAB_LABEL);
    syncTabLabel("Parser rewrite");
    await settle();
    tab = tabGet("Parser rewrite");
    sent = [];
    await restoreTabLabel();
    expect(renames()).not.toContain(TRANSIENT_TAB_LABEL);
  });

  it("still honours the split-tab guard on an adopted tab", async () => {
    process.env.HYDRA_TAB_LABEL = "fix the parser";
    tab = tabGet("fix the parser", 2);
    syncTabLabel("Parser rewrite");
    await settle();
    expect(renames()).toEqual([]);
  });

  it("hands the tab back once the user renames over us", async () => {
    process.env.HYDRA_TAB_LABEL = "fix the parser";
    tab = tabGet("fix the parser");
    syncTabLabel("first");
    await settle();
    tab = tabGet("user label");
    syncTabLabel("second");
    await settle();
    expect(renames()).toEqual(["first"]);
  });

  it("does not restore an adopted label on exit — it's a stale session title", async () => {
    process.env.HYDRA_TAB_LABEL = "fix the parser";
    tab = tabGet("fix the parser");
    syncTabLabel("Parser rewrite");
    await settle();
    sent = [];
    tab = tabGet("Parser rewrite");
    await restoreTabLabel();
    expect(sent).toEqual([]);
  });

  it("ignores the variable in a tab hydra did not create", async () => {
    // Inherited by accident (e.g. exported in a shell rc): it names a tab
    // that isn't this one, so it must not match and must not grant
    // ownership of someone else's label.
    process.env.HYDRA_TAB_LABEL = "some other tab";
    tab = tabGet("human named");
    syncTabLabel("title");
    await settle();
    expect(renames()).toEqual([]);
  });
});

// While the picker is up the pane isn't showing a session, so leaving the
// session's name on the tab reads from the tab bar as "still in that
// session". A transient label says what the pane actually holds — but must
// never be what the tab is left holding.
describe("transient labels", () => {
  afterEach(() => {
    delete process.env.HYDRA_TAB_LABEL;
  });

  it("writes a transient label like any other", async () => {
    syncTabLabel("session title");
    await settle();
    tab = tabGet("session title");
    syncTabLabel("hydra", { transient: true });
    await settle();
    expect(renames()).toEqual(["session title", "hydra"]);
  });

  it("goes back to the session title when the picker closes", async () => {
    syncTabLabel("session title");
    await settle();
    tab = tabGet("session title");
    syncTabLabel("hydra", { transient: true });
    await settle();
    tab = tabGet("hydra");
    syncTabLabel("session title");
    await settle();
    expect(renames()).toEqual(["session title", "hydra", "session title"]);
  });

  it("restores the ORIGINAL label when quitting from the picker", async () => {
    // Quitting straight out of the picker is the normal way to quit, so
    // this is the common exit path, not an edge case.
    syncTabLabel("session title");
    await settle();
    tab = tabGet("session title");
    syncTabLabel("hydra", { transient: true });
    await settle();
    sent = [];
    tab = tabGet("hydra");
    await restoreTabLabel();
    expect(renames()).toEqual(["1"]);
  });

  it("restores the last real session label on a hydra-created tab", async () => {
    // An adopted tab has no sensible "original" to go back to, but it must
    // still not be left named after the picker.
    process.env.HYDRA_TAB_LABEL = "created as";
    tab = tabGet("created as");
    syncTabLabel("session title");
    await settle();
    tab = tabGet("session title");
    syncTabLabel("hydra", { transient: true });
    await settle();
    sent = [];
    tab = tabGet("hydra");
    await restoreTabLabel();
    expect(renames()).toEqual(["session title"]);
  });

  it("falls back to the adopted label when the picker was the only thing shown", async () => {
    process.env.HYDRA_TAB_LABEL = "created as";
    tab = tabGet("created as");
    syncTabLabel("hydra", { transient: true });
    await settle();
    sent = [];
    tab = tabGet("hydra");
    await restoreTabLabel();
    expect(renames()).toEqual(["created as"]);
  });

  it("spends no round trip restoring an adopted tab that never went transient", async () => {
    process.env.HYDRA_TAB_LABEL = "created as";
    tab = tabGet("created as");
    syncTabLabel("session title");
    await settle();
    sent = [];
    tab = tabGet("session title");
    await restoreTabLabel();
    expect(renames()).toEqual([]);
  });

  it("does not let a transient label become the restore target", async () => {
    syncTabLabel("hydra", { transient: true });
    await settle();
    tab = tabGet("hydra");
    syncTabLabel("real title");
    await settle();
    sent = [];
    tab = tabGet("real title");
    await restoreTabLabel();
    expect(renames()).toEqual(["1"]);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Sent {
  method: string;
  params: Record<string, unknown>;
}
let sent: Sent[];
// Reply per method, so a test can stage what tab.get reports.
let replies: Record<string, unknown>;

vi.mock("./herdr-open.js", () => ({
  TAB_LABEL_ENV: "HYDRA_HERDR_TAB_LABEL",
  herdrRequest: (method: string, params: unknown) => {
    sent.push({ method, params: params as Record<string, unknown> });
    const reply = replies[method];
    if (reply instanceof Error) {
      return Promise.reject(reply);
    }
    return Promise.resolve(reply ?? { result: { type: "ok" } });
  },
}));

import {
  __resetHerdrTabLabelForTests,
  isAutoTabLabel,
  mayRenameTab,
  restoreHerdrTabLabel,
  syncHerdrTabLabel,
} from "./herdr-tab-label.js";

function tabGet(label: string, paneCount = 1): unknown {
  return { result: { type: "tab_info", tab: { label, pane_count: paneCount } } };
}

// syncHerdrTabLabel is fire-and-forget; let its chain settle.
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

function renames(): string[] {
  return sent.filter((s) => s.method === "tab.rename").map((s) => s.params.label as string);
}

beforeEach(() => {
  sent = [];
  replies = { "tab.get": tabGet("1") };
  process.env.HERDR_ENV = "1";
  process.env.HERDR_SOCKET_PATH = "/tmp/fake-herdr.sock";
  process.env.HERDR_TAB_ID = "w1:1";
  __resetHerdrTabLabelForTests();
});

afterEach(() => {
  delete process.env.HERDR_ENV;
  delete process.env.HERDR_SOCKET_PATH;
  delete process.env.HERDR_TAB_ID;
});

describe("isAutoTabLabel", () => {
  it("treats herdr's numeric default as auto-generated", () => {
    expect(isAutoTabLabel("1")).toBe(true);
    expect(isAutoTabLabel("12")).toBe(true);
  });

  it("treats an empty label as auto-generated", () => {
    expect(isAutoTabLabel("")).toBe(true);
    expect(isAutoTabLabel("   ")).toBe(true);
  });

  it("treats anything a human would type as owned", () => {
    expect(isAutoTabLabel("review")).toBe(false);
    expect(isAutoTabLabel("tab 2")).toBe(false);
    // Not numeric-only: a session titled "2fa" is still a real name.
    expect(isAutoTabLabel("2fa")).toBe(false);
  });
});

describe("mayRenameTab", () => {
  it("refuses a split tab even when the label is auto-generated", () => {
    expect(mayRenameTab("1", 2)).toBe(false);
  });

  it("allows a single-pane tab with an auto label", () => {
    expect(mayRenameTab("1", 1)).toBe(true);
  });

  it("refuses a label the user chose", () => {
    expect(mayRenameTab("review", 1)).toBe(false);
  });
});

describe("syncHerdrTabLabel", () => {
  it("renames a freshly auto-labelled tab", async () => {
    syncHerdrTabLabel("fix the parser");
    await settle();
    expect(sent[0]?.method).toBe("tab.get");
    expect(sent[1]).toEqual({
      method: "tab.rename",
      params: { tab_id: "w1:1", label: "fix the parser" },
    });
  });

  it("keeps following the title after its own rename", async () => {
    syncHerdrTabLabel("first");
    await settle();
    // The tab now reports OUR label, which is not auto-generated. Without
    // tracking what we wrote, guard (1) would lock us out after one write.
    replies["tab.get"] = tabGet("first");
    syncHerdrTabLabel("second");
    await settle();
    expect(renames()).toEqual(["first", "second"]);
  });

  it("does not stomp a label the user set", async () => {
    replies["tab.get"] = tabGet("my tab");
    syncHerdrTabLabel("session title");
    await settle();
    expect(renames()).toEqual([]);
  });

  it("backs off permanently once the user renames over us", async () => {
    syncHerdrTabLabel("ours");
    await settle();
    replies["tab.get"] = tabGet("theirs");
    syncHerdrTabLabel("ours again");
    await settle();
    expect(renames()).toEqual(["ours"]);
  });

  it("does not name a split tab", async () => {
    replies["tab.get"] = tabGet("1", 2);
    syncHerdrTabLabel("session title");
    await settle();
    expect(renames()).toEqual([]);
  });

  it("re-checks the guards on every title change, not once", async () => {
    syncHerdrTabLabel("first");
    await settle();
    // User splits the tab mid-session.
    replies["tab.get"] = tabGet("first", 2);
    syncHerdrTabLabel("second");
    await settle();
    expect(renames()).toEqual(["first"]);
  });

  it("skips a redundant write when the title has not changed", async () => {
    syncHerdrTabLabel("same");
    await settle();
    replies["tab.get"] = tabGet("same");
    syncHerdrTabLabel("same");
    await settle();
    expect(renames()).toEqual(["same"]);
    expect(sent.filter((s) => s.method === "tab.get")).toHaveLength(1);
  });

  it("coalesces titles that arrive during a round trip, dropping the intermediates", async () => {
    syncHerdrTabLabel("a");
    syncHerdrTabLabel("b");
    syncHerdrTabLabel("c");
    await settle();
    // "a" was already in flight when "b" and "c" arrived, so it lands.
    // "b" is discarded — only the newest pending title is ever written,
    // which is what keeps a fast series of title updates from becoming a
    // series of round trips.
    expect(renames()).toEqual(["a", "c"]);
  });

  it("is inert without HERDR_TAB_ID", async () => {
    delete process.env.HERDR_TAB_ID;
    syncHerdrTabLabel("title");
    await settle();
    expect(sent).toEqual([]);
  });

  it("is inert outside herdr", async () => {
    delete process.env.HERDR_ENV;
    syncHerdrTabLabel("title");
    await settle();
    expect(sent).toEqual([]);
  });

  it("ignores an empty title rather than blanking the tab", async () => {
    syncHerdrTabLabel("");
    syncHerdrTabLabel(null);
    syncHerdrTabLabel(undefined);
    await settle();
    expect(sent).toEqual([]);
  });

  it("survives a failing tab.get", async () => {
    replies["tab.get"] = new Error("socket gone");
    syncHerdrTabLabel("title");
    await settle();
    expect(renames()).toEqual([]);
  });

  it("does not record a failed rename as applied", async () => {
    replies["tab.rename"] = { error: { code: "not_found" } };
    syncHerdrTabLabel("title");
    await settle();
    replies["tab.rename"] = { result: { type: "ok" } };
    syncHerdrTabLabel("title");
    await settle();
    expect(renames()).toEqual(["title", "title"]);
  });
});

describe("restoreHerdrTabLabel", () => {
  it("puts the original auto label back", async () => {
    syncHerdrTabLabel("session title");
    await settle();
    sent = [];
    replies["tab.get"] = tabGet("session title");
    await restoreHerdrTabLabel();
    expect(renames()).toEqual(["1"]);
  });

  it("does nothing when we never renamed", async () => {
    replies["tab.get"] = tabGet("user label");
    syncHerdrTabLabel("session title");
    await settle();
    sent = [];
    await restoreHerdrTabLabel();
    expect(sent).toEqual([]);
  });

  it("leaves a label the user set after us alone", async () => {
    syncHerdrTabLabel("session title");
    await settle();
    sent = [];
    replies["tab.get"] = tabGet("user renamed it");
    await restoreHerdrTabLabel();
    expect(renames()).toEqual([]);
  });

  it("restores the label we found, not the tab number, when the tab was named on creation", async () => {
    // ^t-created tabs come up labelled with the session title already.
    replies["tab.get"] = tabGet("3");
    syncHerdrTabLabel("a");
    await settle();
    replies["tab.get"] = tabGet("a");
    syncHerdrTabLabel("b");
    await settle();
    sent = [];
    replies["tab.get"] = tabGet("b");
    await restoreHerdrTabLabel();
    expect(renames()).toEqual(["3"]);
  });

  it("is idempotent", async () => {
    syncHerdrTabLabel("session title");
    await settle();
    replies["tab.get"] = tabGet("session title");
    await restoreHerdrTabLabel();
    sent = [];
    await restoreHerdrTabLabel();
    expect(sent).toEqual([]);
  });
});

// A ^t-created tab arrives already labelled by the hydra that created it,
// which is a different process. Without an ownership hand-off, guard (1)
// mistakes our own label for a human's and the tab never follows the
// title — the exact case where following it matters most.
describe("ownership adopted from the creating process", () => {
  afterEach(() => {
    delete process.env.HYDRA_HERDR_TAB_LABEL;
  });

  it("renames a tab we created, despite the label not being auto-generated", async () => {
    process.env.HYDRA_HERDR_TAB_LABEL = "fix the parser";
    replies["tab.get"] = tabGet("fix the parser");
    syncHerdrTabLabel("Parser rewrite");
    await settle();
    expect(renames()).toEqual(["Parser rewrite"]);
  });

  it("does not adopt when the user has renamed the tab since it was created", async () => {
    process.env.HYDRA_HERDR_TAB_LABEL = "fix the parser";
    replies["tab.get"] = tabGet("mine now");
    syncHerdrTabLabel("Parser rewrite");
    await settle();
    expect(renames()).toEqual([]);
  });

  it("still honours the split-tab guard on an adopted tab", async () => {
    process.env.HYDRA_HERDR_TAB_LABEL = "fix the parser";
    replies["tab.get"] = tabGet("fix the parser", 2);
    syncHerdrTabLabel("Parser rewrite");
    await settle();
    expect(renames()).toEqual([]);
  });

  it("hands the tab back once the user renames over us", async () => {
    process.env.HYDRA_HERDR_TAB_LABEL = "fix the parser";
    replies["tab.get"] = tabGet("fix the parser");
    syncHerdrTabLabel("first");
    await settle();
    replies["tab.get"] = tabGet("user label");
    syncHerdrTabLabel("second");
    await settle();
    expect(renames()).toEqual(["first"]);
  });

  it("does not restore an adopted label on exit — it's a stale session title", async () => {
    process.env.HYDRA_HERDR_TAB_LABEL = "fix the parser";
    replies["tab.get"] = tabGet("fix the parser");
    syncHerdrTabLabel("Parser rewrite");
    await settle();
    sent = [];
    replies["tab.get"] = tabGet("Parser rewrite");
    await restoreHerdrTabLabel();
    expect(sent).toEqual([]);
  });

  it("ignores the variable in a tab hydra did not create", async () => {
    // Inherited by accident (e.g. exported in a shell rc): it names a tab
    // that isn't this one, so it must not match and must not grant
    // ownership of someone else's label.
    process.env.HYDRA_HERDR_TAB_LABEL = "some other tab";
    replies["tab.get"] = tabGet("human named");
    syncHerdrTabLabel("title");
    await settle();
    expect(renames()).toEqual([]);
  });
});

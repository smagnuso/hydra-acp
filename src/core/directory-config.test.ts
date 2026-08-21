import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  DIRECTORY_CONFIG_FILENAME,
  applyDirectoryConfig,
  currentDirectoryOverlay,
  deepMergeConfig,
  directoryConfigNotices,
  findDirectoryConfigs,
  setDirectoryOverlay,
} from "./directory-config.js";

let root: string;
const savedHome = process.env.HYDRA_ACP_HOME;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-dirconfig-"));
});

afterEach(async () => {
  setDirectoryOverlay(undefined);
  if (savedHome === undefined) {
    delete process.env.HYDRA_ACP_HOME;
  } else {
    process.env.HYDRA_ACP_HOME = savedHome;
  }
  await fs.rm(root, { recursive: true, force: true });
});

async function writeConfigAt(
  dir: string,
  data: Record<string, unknown>,
): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, DIRECTORY_CONFIG_FILENAME);
  await fs.writeFile(file, JSON.stringify(data), "utf8");
  return file;
}

describe("deepMergeConfig", () => {
  it("merges objects and replaces scalars", () => {
    expect(
      deepMergeConfig(
        { tui: { mouse: false, showThoughts: true }, defaultAgent: "a" },
        { tui: { mouse: true }, defaultAgent: "b" },
      ),
    ).toEqual({
      tui: { mouse: true, showThoughts: true },
      defaultAgent: "b",
    });
  });

  it("replaces arrays rather than concatenating", () => {
    expect(
      deepMergeConfig({ defaultTransformers: ["a", "b"] }, { defaultTransformers: ["c"] }),
    ).toEqual({ defaultTransformers: ["c"] });
  });
});

describe("findDirectoryConfigs", () => {
  it("returns layers outermost-first so the nearest one wins", async () => {
    const outer = await writeConfigAt(root, { defaultAgent: "outer" });
    const innerDir = path.join(root, "a", "b");
    const inner = await writeConfigAt(innerDir, { defaultAgent: "inner" });

    const { layers } = await findDirectoryConfigs(innerDir, root);
    expect(layers.map((l) => l.file)).toEqual([outer, inner]);

    let merged: Record<string, unknown> = {};
    for (const l of layers) {
      merged = deepMergeConfig(merged, l.data);
    }
    expect(merged.defaultAgent).toBe("inner");
  });

  it("stops at the boundary directory", async () => {
    await writeConfigAt(root, { defaultAgent: "above" });
    const stop = path.join(root, "stop");
    await writeConfigAt(stop, { defaultAgent: "at-stop" });
    const deep = path.join(stop, "x");
    await fs.mkdir(deep, { recursive: true });

    const { layers } = await findDirectoryConfigs(deep, stop);
    expect(layers.map((l) => l.data.defaultAgent)).toEqual(["at-stop"]);
  });

  it("reports malformed JSON and keeps going instead of throwing", async () => {
    await fs.writeFile(
      path.join(root, DIRECTORY_CONFIG_FILENAME),
      "{ not json",
      "utf8",
    );
    const sub = path.join(root, "sub");
    await writeConfigAt(sub, { defaultAgent: "fine" });

    const { layers, notices } = await findDirectoryConfigs(sub, root);
    expect(layers.map((l) => l.data.defaultAgent)).toEqual(["fine"]);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.message).toMatch(/not valid JSON/);
  });

  it("ignores a file whose top level is not an object", async () => {
    await fs.writeFile(
      path.join(root, DIRECTORY_CONFIG_FILENAME),
      "[1,2,3]",
      "utf8",
    );
    const { layers, notices } = await findDirectoryConfigs(root, root);
    expect(layers).toHaveLength(0);
    expect(notices[0]?.message).toMatch(/expected a JSON object/);
  });
});

describe("directoryConfigNotices", () => {
  it("flags daemon-owned keys that cannot take effect", () => {
    const notices = directoryConfigNotices([
      { file: "/x/.hydra-acp.json", data: { agents: {}, defaultAgent: "a" } },
    ]);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.key).toBe("agents");
    expect(notices[0]?.message).toMatch(/no effect in a directory config/);
  });

  it("flags `daemon` separately, since it does change the client's dial target", () => {
    const notices = directoryConfigNotices([
      { file: "/x/.hydra-acp.json", data: { daemon: { port: 1 } } },
    ]);
    expect(notices[0]?.message).toMatch(/Use `home` for a separate daemon/);
  });

  it("says nothing about keys the client actually reads", () => {
    expect(
      directoryConfigNotices([
        {
          file: "/x/.hydra-acp.json",
          data: { defaultAgent: "a", defaultModels: {}, tui: {} },
        },
      ]),
    ).toEqual([]);
  });
});

describe("applyDirectoryConfig", () => {
  it("installs the merged overlay", async () => {
    const dir = path.join(root, "proj");
    await writeConfigAt(dir, { defaultAgent: "claude-home" });
    await applyDirectoryConfig(dir);
    expect(currentDirectoryOverlay()).toEqual({ defaultAgent: "claude-home" });
  });

  it("installs no overlay when there is no file", async () => {
    setDirectoryOverlay({ stale: true });
    const dir = path.join(root, "empty");
    await fs.mkdir(dir, { recursive: true });
    await applyDirectoryConfig(dir);
    expect(currentDirectoryOverlay()).toBeUndefined();
  });

  it("re-roots HYDRA_ACP_HOME and keeps `home` out of the overlay", async () => {
    delete process.env.HYDRA_ACP_HOME;
    const dir = path.join(root, "personal");
    const home = path.join(root, "hydra-personal");
    await writeConfigAt(dir, { home, defaultAgent: "claude-home" });

    const applied = await applyDirectoryConfig(dir);
    expect(applied.home).toBe(home);
    expect(process.env.HYDRA_ACP_HOME).toBe(home);
    // `home` is not a HydraConfig key — it must not survive into the
    // overlay that gets merged and parsed.
    expect(currentDirectoryOverlay()).toEqual({ defaultAgent: "claude-home" });
  });

  it("expands ~ in `home`", async () => {
    delete process.env.HYDRA_ACP_HOME;
    const dir = path.join(root, "tilde");
    await writeConfigAt(dir, { home: "~/.hydra-tilde-test" });
    const applied = await applyDirectoryConfig(dir);
    expect(applied.home).toBe(path.join(os.homedir(), ".hydra-tilde-test"));
  });

  it("lets an explicitly exported HYDRA_ACP_HOME beat `home`", async () => {
    // Env beats config file, and the test harness depends on it:
    // vitest.setup.ts clamps HYDRA_ACP_HOME to a per-worker tmpdir so a
    // test can never write to the real ~/.hydra-acp. A stray
    // `.hydra-acp.json` above a temp cwd must not be able to undo that.
    const pinned = path.join(root, "pinned-home");
    process.env.HYDRA_ACP_HOME = pinned;
    const dir = path.join(root, "wants-other-home");
    await writeConfigAt(dir, { home: path.join(root, "other"), defaultAgent: "a" });

    const applied = await applyDirectoryConfig(dir);
    expect(applied.home).toBeUndefined();
    expect(process.env.HYDRA_ACP_HOME).toBe(pinned);
    expect(applied.notices.some((n) => /already set/.test(n.message))).toBe(true);
    // The rest of the overlay still applies.
    expect(currentDirectoryOverlay()).toEqual({ defaultAgent: "a" });
  });

  it("ignores a non-string `home` with a notice", async () => {
    const dir = path.join(root, "badhome");
    await writeConfigAt(dir, { home: 42, defaultAgent: "a" });
    const before = process.env.HYDRA_ACP_HOME;
    const applied = await applyDirectoryConfig(dir);
    expect(applied.home).toBeUndefined();
    expect(process.env.HYDRA_ACP_HOME).toBe(before);
    expect(applied.notices.some((n) => n.key === "home")).toBe(true);
  });

  it("lets the nearest file win key-by-key while inheriting the rest", async () => {
    await writeConfigAt(root, {
      defaultAgent: "outer",
      tui: { mouse: true, showThoughts: false },
    });
    const dir = path.join(root, "inner");
    await writeConfigAt(dir, { tui: { mouse: false } });

    await applyDirectoryConfig(dir);
    expect(currentDirectoryOverlay()).toEqual({
      defaultAgent: "outer",
      tui: { mouse: false, showThoughts: false },
    });
  });
});

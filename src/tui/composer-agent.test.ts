import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { HydraConfig } from "../core/config.js";
import { DIRECTORY_CONFIG_FILENAME } from "../core/directory-config.js";
import { composerAgentForCwd, resolveComposerAgent } from "./composer-agent.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "hydra-composer-agent-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function writeConfigAt(
  dir: string,
  data: Record<string, unknown>,
): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, DIRECTORY_CONFIG_FILENAME),
    JSON.stringify(data),
    "utf8",
  );
}

describe("resolveComposerAgent", () => {
  it("prefers a directory default over a sticky last choice", () => {
    // The point of the rule: `lastChosenAgent` is implicit global
    // stickiness, a `.hydra-acp.json` is an explicit claim about a tree.
    expect(
      resolveComposerAgent({
        directoryDefaultAgent: "claude-home",
        prefs: { lastChosenAgent: "opencode", lastChosenModel: "gpt-5" },
        configDefaultAgent: "opencode",
        availableAgents: [],
      }),
    ).toEqual({ agentId: "claude-home" });
  });

  it("falls back through lastChosen, opts, then config", () => {
    expect(
      resolveComposerAgent({
        prefs: { lastChosenAgent: "sticky" },
        fallbackAgentId: "attached",
        configDefaultAgent: "global",
        availableAgents: [],
      }).agentId,
    ).toBe("sticky");
    expect(
      resolveComposerAgent({
        prefs: {},
        fallbackAgentId: "attached",
        configDefaultAgent: "global",
        availableAgents: [],
      }).agentId,
    ).toBe("attached");
    expect(
      resolveComposerAgent({
        prefs: {},
        configDefaultAgent: "global",
        availableAgents: [],
      }).agentId,
    ).toBe("global");
  });

  it("returns nothing when no source names an agent", () => {
    expect(resolveComposerAgent({ prefs: {}, availableAgents: [] })).toEqual({});
  });

  it("prefers a directory model over the global one", () => {
    expect(
      resolveComposerAgent({
        directoryDefaultModels: { claude: "sonnet" },
        prefs: {},
        configDefaultAgent: "claude",
        configDefaultModels: { claude: "opus" },
        availableAgents: [],
      }),
    ).toEqual({ agentId: "claude", model: "sonnet" });
  });

  it("does not pair a remembered model with a different agent", () => {
    // lastChosenModel belongs to lastChosenAgent. When a directory
    // default supplies a different agent, carrying the model over would
    // paint a combination the user never picked.
    expect(
      resolveComposerAgent({
        directoryDefaultAgent: "claude-home",
        prefs: { lastChosenAgent: "opencode", lastChosenModel: "gpt-5" },
        availableAgents: [],
      }),
    ).toEqual({ agentId: "claude-home" });
  });

  it("keeps a remembered model when the agent matches", () => {
    expect(
      resolveComposerAgent({
        prefs: { lastChosenAgent: "opencode", lastChosenModel: "gpt-5" },
        configDefaultModels: { opencode: "grok" },
        availableAgents: [],
      }),
    ).toEqual({ agentId: "opencode", model: "gpt-5" });
  });

  it("walks the extends chain for a derived agent's model", () => {
    expect(
      resolveComposerAgent({
        prefs: {},
        configDefaultAgent: "claude-acp-dev",
        configDefaultModels: { "claude-acp": "opus" },
        availableAgents: [
          { id: "claude-acp-dev", extendsChain: ["claude-acp-dev", "claude-acp"] },
        ],
      }),
    ).toEqual({ agentId: "claude-acp-dev", model: "opus" });
  });

  it("walks the chain for a directory model too", () => {
    expect(
      resolveComposerAgent({
        directoryDefaultModels: { "claude-acp": "haiku" },
        prefs: {},
        configDefaultAgent: "claude-acp-dev",
        configDefaultModels: { "claude-acp": "opus" },
        availableAgents: [
          { id: "claude-acp-dev", extendsChain: ["claude-acp-dev", "claude-acp"] },
        ],
      }),
    ).toEqual({ agentId: "claude-acp-dev", model: "haiku" });
  });
});

describe("composerAgentForCwd", () => {
  const config = HydraConfig.parse({
    defaultAgent: "opencode",
    defaultModels: { opencode: "grok" },
  });

  it("reads defaultAgent and defaultModels out of the tree's config", async () => {
    const dir = path.join(root, "work");
    await writeConfigAt(dir, {
      defaultAgent: "claude-acp",
      defaultModels: { "claude-acp": "opus" },
    });
    expect(
      await composerAgentForCwd({
        cwd: dir,
        config,
        prefs: {},
        availableAgents: [],
      }),
    ).toEqual({ agentId: "claude-acp", model: "opus" });
  });

  it("falls back to the global config where the tree says nothing", async () => {
    const dir = path.join(root, "plain");
    await fs.mkdir(dir, { recursive: true });
    expect(
      await composerAgentForCwd({
        cwd: dir,
        config,
        prefs: {},
        availableAgents: [],
      }),
    ).toEqual({ agentId: "opencode", model: "grok" });
  });

  it("reports a `home` key instead of re-rooting the process", async () => {
    const before = process.env.HYDRA_ACP_HOME;
    const dir = path.join(root, "personal");
    await writeConfigAt(dir, {
      home: path.join(root, "hydra-personal"),
      defaultAgent: "claude-home",
    });

    const result = await composerAgentForCwd({
      cwd: dir,
      config,
      prefs: {},
      availableAgents: [],
    });
    expect(result.agentId).toBe("claude-home");
    expect(result.notice).toMatch(/separate daemon/);
    expect(process.env.HYDRA_ACP_HOME).toBe(before);
  });

  it("ignores a malformed directory config rather than blanking the label", async () => {
    const dir = path.join(root, "broken");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, DIRECTORY_CONFIG_FILENAME),
      "{not json",
      "utf8",
    );
    expect(
      (await composerAgentForCwd({
        cwd: dir,
        config,
        prefs: {},
        availableAgents: [],
      })).agentId,
    ).toBe("opencode");
  });
});

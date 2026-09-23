import { describe, expect, it } from "vitest";
import {
  composerConfigLabel,
  composerConfigRows,
  cycleComposerConfig,
  type ComposerConfigChoices,
} from "./composer-config.js";

const choices: ComposerConfigChoices = {
  agents: [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
  ],
  hosts: ["mrclean", "box"],
  models: ["opus", "sonnet"],
  defaultModelFor: (agent, host) =>
    host === "mrclean" && agent?.id === "z"
      ? "haiku"
      : host === undefined && agent?.id === "b"
        ? "sonnet"
        : undefined,
  localDefaultAgent: "a",
};

describe("composer config", () => {
  it("omits the host row when there are no remotes", () => {
    expect(composerConfigRows({ ...choices, hosts: [] })).toEqual([
      "agent",
      "model",
    ]);
    expect(composerConfigRows(choices)).toEqual(["agent", "model", "host"]);
  });

  it("cycles the host through local and every remote, wrapping", () => {
    let s = cycleComposerConfig({ agentId: "a" }, "host", 1, choices);
    expect(s.host).toBe("mrclean");
    s = cycleComposerConfig(s, "host", 1, choices);
    s = cycleComposerConfig(s, "host", 1, choices);
    expect(s.host).toBeUndefined();
    s = cycleComposerConfig(s, "host", -1, choices);
    expect(s.host).toBe("box");
    expect(composerConfigLabel({}, "host")).toBe("local");
  });

  it("resets the model to the new agent's default on agent change", () => {
    const s = cycleComposerConfig({ agentId: "a", model: "opus" }, "agent", 1, choices);
    expect(s).toEqual({ agentId: "b", model: "sonnet" });
    const back = cycleComposerConfig(s, "agent", 1, choices);
    expect(back).toEqual({ agentId: "a" });
  });

  it("cycles the model through the agent default and known models", () => {
    let s = cycleComposerConfig({ agentId: "a" }, "model", 1, choices);
    expect(s.model).toBe("opus");
    s = cycleComposerConfig(s, "model", -1, choices);
    expect(s.model).toBeUndefined();
  });

  it("moves off an agent the chosen host does not offer", () => {
    const withPeer = {
      ...choices,
      hostInfo: { mrclean: { agents: [{ id: "z", name: "Z" }] } },
    };
    const s = cycleComposerConfig({ agentId: "b", model: "sonnet" }, "host", 1, withPeer);
    expect(s).toEqual({ agentId: "z", host: "mrclean", model: "haiku" });
  });

  it("adopts the host's default agent and model when the agent was the local default", () => {
    const withPeer = {
      ...choices,
      hostInfo: {
        mrclean: {
          agents: [
            { id: "a", name: "A" },
            { id: "z", name: "Z" },
          ],
          defaultAgent: "z",
        },
      },
    };
    const s = cycleComposerConfig({ agentId: "a" }, "host", 1, withPeer);
    expect(s).toEqual({ agentId: "z", host: "mrclean", model: "haiku" });
    const back = cycleComposerConfig(s, "host", 1, { ...withPeer, hosts: ["mrclean"] });
    expect(back).toEqual({ agentId: "a" });
  });

  it("keeps an explicitly chosen agent the new host also offers", () => {
    const withPeer = {
      ...choices,
      hostInfo: {
        mrclean: {
          agents: [
            { id: "a", name: "A" },
            { id: "b", name: "B" },
            { id: "z", name: "Z" },
          ],
          defaultAgent: "z",
        },
      },
    };
    const s = cycleComposerConfig({ agentId: "b", model: "sonnet" }, "host", 1, withPeer);
    expect(s).toEqual({ agentId: "b", model: "sonnet", host: "mrclean" });
  });

  it("cycles the agent row within the host's own list", () => {
    const withPeer = {
      ...choices,
      hostInfo: { mrclean: { agents: [{ id: "z", name: "Z" }] } },
    };
    const s = cycleComposerConfig({ agentId: "z", host: "mrclean" }, "agent", 1, withPeer);
    expect(s).toEqual({ agentId: "z", host: "mrclean", model: "haiku" });
  });
});

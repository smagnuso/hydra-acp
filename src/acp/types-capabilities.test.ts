import { describe, expect, it } from "vitest";
import { HYDRA_CLIENT_CAPABILITIES } from "./types-capabilities.js";

describe("HYDRA_CLIENT_CAPABILITIES", () => {
  it("advertises form elicitation to agents, and not url mode", () => {
    expect(HYDRA_CLIENT_CAPABILITIES.elicitation).toEqual({ form: {} });
  });
});

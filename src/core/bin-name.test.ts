import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { invokedBinName } from "./bin-name.js";

describe("invokedBinName", () => {
  const savedArgv1 = process.argv[1] ?? "";
  beforeEach(() => {
    process.argv[1] = savedArgv1;
  });
  afterEach(() => {
    process.argv[1] = savedArgv1;
  });

  it("returns the basename of the invoked symlink", () => {
    process.argv[1] = "/usr/local/bin/hydra";
    expect(invokedBinName()).toBe("hydra");
  });

  it("returns hydra-acp when invoked under that name", () => {
    process.argv[1] = "/opt/foo/bin/hydra-acp";
    expect(invokedBinName()).toBe("hydra-acp");
  });

  it("normalises cli.js (developer running the bundle directly) to hydra-acp", () => {
    process.argv[1] = "/home/dev/hydra-acp/cli/dist/cli.js";
    expect(invokedBinName()).toBe("hydra-acp");
  });

  it("falls back to hydra-acp when argv[1] is missing", () => {
    delete (process.argv as Array<string | undefined>)[1];
    expect(invokedBinName()).toBe("hydra-acp");
  });

  it("preserves custom names (useful for forks / wrapper scripts)", () => {
    process.argv[1] = "/usr/local/bin/myhydra";
    expect(invokedBinName()).toBe("myhydra");
  });
});

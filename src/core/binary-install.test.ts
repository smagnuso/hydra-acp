import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  currentPlatformKey,
  ensureBinary,
  pickBinaryTarget,
  type BinaryDistribution,
} from "./binary-install.js";
import { paths } from "./paths.js";

describe("pickBinaryTarget", () => {
  const dist: BinaryDistribution = {
    "linux-x86_64": { archive: "https://example.invalid/x.tar.gz", cmd: "./x" },
    "darwin-aarch64": {
      archive: "https://example.invalid/y.tar.gz",
      cmd: "./y",
    },
  };

  it("returns the entry for the requested platform key", () => {
    expect(pickBinaryTarget(dist, "linux-x86_64")?.cmd).toBe("./x");
    expect(pickBinaryTarget(dist, "darwin-aarch64")?.cmd).toBe("./y");
  });

  it("returns undefined for a platform key that isn't published", () => {
    expect(pickBinaryTarget(dist, "windows-x86_64")).toBeUndefined();
  });
});

describe("ensureBinary", () => {
  it("short-circuits if the cmd already exists in the install dir", async () => {
    // Seed the expected install layout so ensureBinary returns without
    // ever hitting the network. The platform key has to match the test
    // host's because ensureBinary derives it from process.platform/arch.
    const platformKey = currentPlatformKey();
    if (!platformKey) {
      return;
    }
    const installDir = paths.agentInstallDir(
      "fake-agent",
      platformKey,
      "9.9.9",
    );
    await fs.mkdir(installDir, { recursive: true });
    const seeded = path.join(installDir, "fake-bin");
    await fs.writeFile(seeded, "#!/bin/sh\necho hi\n", { mode: 0o755 });

    const cmdPath = await ensureBinary({
      agentId: "fake-agent",
      version: "9.9.9",
      target: {
        archive: "https://example.invalid/never-fetched.tar.gz",
        cmd: "./fake-bin",
      },
    });

    expect(cmdPath).toBe(seeded);
  });

  it(
    "downloads, extracts, and chmod 755s a real tar.gz",
    { timeout: 15_000 },
    async () => {
      if (process.platform === "win32") {
        return;
      }
      const stage = await fs.mkdtemp(path.join(os.tmpdir(), "bin-install-"));
      try {
        // Build a tiny tarball: one shell-script "binary" sitting at the
        // archive root, so the registry-style cmd="./fakebin" resolves.
        const payloadDir = path.join(stage, "payload");
        await fs.mkdir(payloadDir);
        await fs.writeFile(
          path.join(payloadDir, "fakebin"),
          "#!/bin/sh\necho ok\n",
        );
        // Intentionally NOT 0o755 — so we can confirm ensureBinary chmods it.
        await fs.chmod(path.join(payloadDir, "fakebin"), 0o644);

        const archive = path.join(stage, "fake-1.0.0.tar.gz");
        await runCmd("tar", ["-czf", archive, "-C", payloadDir, "fakebin"]);

        const server = http.createServer((req, res) => {
          if (req.url !== "/fake-1.0.0.tar.gz") {
            res.statusCode = 404;
            res.end();
            return;
          }
          fs.readFile(archive)
            .then((buf) => {
              res.setHeader("content-type", "application/gzip");
              res.end(buf);
            })
            .catch(() => {
              res.statusCode = 500;
              res.end();
            });
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        try {
          const addr = server.address();
          if (!addr || typeof addr === "string") {
            throw new Error("no server addr");
          }
          const url = `http://127.0.0.1:${addr.port}/fake-1.0.0.tar.gz`;

          const cmdPath = await ensureBinary({
            agentId: "fake-agent",
            version: "1.0.0",
            target: { archive: url, cmd: "./fakebin" },
          });

          const platformKey = currentPlatformKey()!;
          expect(cmdPath).toBe(
            path.join(
              paths.agentInstallDir("fake-agent", platformKey, "1.0.0"),
              "fakebin",
            ),
          );
          const st = await fs.stat(cmdPath);
          // ensureBinary should have chmod'd it executable on POSIX.
          expect(st.mode & 0o100).toBe(0o100);
          // And it should actually run.
          const proc = spawn(cmdPath, [], { stdio: ["ignore", "pipe", "ignore"] });
          let out = "";
          proc.stdout.on("data", (c: Buffer) => {
            out += c.toString("utf8");
          });
          const [code] = (await once(proc, "exit")) as [number | null];
          expect(code).toBe(0);
          expect(out.trim()).toBe("ok");
        } finally {
          server.close();
          await once(server, "close");
        }
      } finally {
        await fs.rm(stage, { recursive: true, force: true });
      }
    },
  );
});

function runCmd(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

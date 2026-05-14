import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeEach } from "vitest";

// Worker-wide root for per-test tmp dirs. Created once at module load
// and torn down in afterAll so the OS doesn't have to garbage-collect us.
const workerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hydra-acp-vitest-"));

// Mint a fresh empty HYDRA_ACP_HOME before every test. Doing this
// globally (instead of in each test's own beforeEach) means tests can't
// accidentally inherit one another's leftover state — every test boots
// from nothing, which surfaces "implicit fixture" bugs that would
// otherwise stay hidden.
//
// SessionStore / HistoryStore call paths.ts on every write and some
// writes are fire-and-forget. Leaving HYDRA_ACP_HOME pointing at the
// (now-deleted) per-test dir on afterEach means a straggler write that
// races past teardown fails with ENOENT inside its surrounding .catch,
// never falling back to ~/.hydra-acp.
let currentHome: string | undefined;

beforeEach(() => {
  currentHome = fs.mkdtempSync(path.join(workerRoot, "home-"));
  process.env.HYDRA_ACP_HOME = currentHome;
  // Tests rely on the legacy `npx -y` plan from planSpawn rather than
  // pre-installing into a temp HYDRA_ACP_HOME — the npm install would
  // hit the network and slow every test to a crawl. The npm-install
  // tests opt back in by `delete process.env.HYDRA_ACP_SKIP_NPM_PREFETCH`.
  process.env.HYDRA_ACP_SKIP_NPM_PREFETCH = "1";
});

afterEach(() => {
  if (currentHome) {
    fs.rmSync(currentHome, { recursive: true, force: true });
    currentHome = undefined;
  }
});

afterAll(() => {
  fs.rmSync(workerRoot, { recursive: true, force: true });
});

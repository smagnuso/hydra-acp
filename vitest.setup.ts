import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { threadId } from "node:worker_threads";
import { afterAll, afterEach, beforeEach } from "vitest";
import { setControlWriter } from "./src/tui/ansi.js";

// Terminal-mode escapes are state in the developer's terminal, not in
// this process, so any that escape a test outlive it. Screen.start() and
// the picker's grab both write them past the injected mock `term`, so
// before this the suite left the runner's own terminal with focus
// reporting on (which then fed \x1b[I / \x1b[O into vitest's stdin) and
// auto-wrap off (which clipped every line the reporter printed after,
// making a live run look hung). Discard them wholesale: no test asserts
// on a mode sequence, and the ones that do assert on OSC content writes
// (title excepted) still spy on process.stdout directly.
setControlWriter(() => {});

// Worker-wide root for per-test tmp dirs. Created once at module load
// and torn down in afterAll so the OS doesn't have to garbage-collect us.
// realpathSync.NATIVE, specifically. os.tmpdir() reads TEMP, which
// GitHub's Windows runners set to an 8.3 short path
// (C:\Users\RUNNER~1\...), while git reports the long form
// (C:\Users\runneradmin\...). Those name one directory and compare
// unequal. HYDRA_ACP_HOME is minted under this root, so leaving it short
// leaks that spelling into every product-side path while fixtures use
// the long one.
//
// The plain fs.realpathSync does NOT fix this: it resolves symlinks by
// walking with lstat and leaves an 8.3 component exactly as it found it.
// Only the .native variant goes through the OS call that expands it.
// Both settle the macOS /var -> /private/var case, so the native one is
// strictly the better default here.
const workerRoot = fs.realpathSync.native(
  fs.mkdtempSync(path.join(os.tmpdir(), "hydra-acp-vitest-")),
);

// Every `git init` in this suite otherwise copies from the developer's
// init.templateDir, which makes the tests depend on a directory outside
// the repo that nothing here controls. That was a real intermittent
// failure, not a theoretical one: a dotfiles sync rewrites
// ~/.git_template/hooks with atomic temp+rename, and a `git init` whose
// readdir sees a temp name that is gone by the stat dies with
//
//   fatal: cannot stat template '~/.git_template/hooks/CuqQwGXs'
//
// which surfaced as unrelated workspace tests failing in ~25ms, roughly
// one run in twenty, and never reproducibly. Point git at an empty
// directory instead: the env var outranks the config, no test asserts on
// hook contents, and copying nothing makes init marginally faster too.
const gitTemplateDir = path.join(workerRoot, "empty-git-template");
fs.mkdirSync(gitTemplateDir, { recursive: true });
process.env.GIT_TEMPLATE_DIR = gitTemplateDir;

// GIT_TEMPLATE_DIR alone was not enough, because a template is only one
// of the ways the developer's environment reaches into a fixture repo.
// core.hooksPath is another, and it is not copied at init time but read
// at command time, so an empty template does nothing about it. A global
// core.hooksPath pointing anywhere unreliable (dotfiles that symlink
// into another checkout, say) fails the fixture's own commits:
//
//   Error: Command failed: git commit -q -m agent work
//   /bin/sh: ~/.git_template/hooks/pre-commit: No such file or directory
//
// which lands as one arbitrary workspace test failing per full-suite run
// and passing when that file is run alone. Other keys are latent traps of
// the same shape: status.showuntrackedfiles=no, diff.renames=copies and
// core.whitespace all change output this suite parses.
//
// So substitute a config of our own for the user's. It is not empty: an
// identity has to come from somewhere. Fixtures set user.name/user.email
// on the repos they create by hand, but a submodule this suite clones
// into a workspace gets a fresh config with no identity, and its commits
// then die on "Author identity unknown" — which presents as a submodule
// test seeing an unexpectedly clean tree, not as an obvious config error.
// Naming the identity here also keeps the developer's own name out of
// fixture commits. Branch names need no equivalent: fixtures pass
// `git init -b main` explicitly.
//
// The GIT_CONFIG_KEY_* injections a couple of tests use still win over
// this, since env-supplied config outranks config files.
const gitConfigFile = path.join(workerRoot, "gitconfig");
fs.writeFileSync(
  gitConfigFile,
  "[user]\n\tname = hydra-acp tests\n\temail = tests@hydra-acp.invalid\n",
);
process.env.GIT_CONFIG_GLOBAL = gitConfigFile;
process.env.GIT_CONFIG_SYSTEM = gitConfigFile;

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

// Retries back off linearly (50ms, 100ms, ...), so N retries can stall a
// test for 25*N*(N+1) ms, and the swallowed error hides why. Set
// HYDRA_ACP_TEST_CLEANUP_LOG to a directory to get one JSON line per sweep
// that retried or gave up: the test, the time spent, the error code and
// what was still on disk.
const cleanupLogDir = process.env.HYDRA_ACP_TEST_CLEANUP_LOG;
const SLOW_SWEEP_MS = 40;

function leftovers(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { recursive: true })
      .map(String)
      .slice(0, 50);
  } catch {
    return [];
  }
}

// Async on purpose: rmSync sleeps between retries with the event loop
// blocked, so a stream whose end() was already called (agent and extension
// logs, an appendFile in flight) never gets the turn it needs to close its
// file, and on Windows that open file keeps the directory from going.
async function sweep(dir: string, test: string, maxRetries: number): Promise<void> {
  const started = Date.now();
  let error: NodeJS.ErrnoException | undefined;
  try {
    await fs.promises.rm(dir, {
      recursive: true,
      force: true,
      maxRetries,
      retryDelay: 50,
    });
  } catch (err) {
    error = err as NodeJS.ErrnoException;
  }
  const ms = Date.now() - started;
  if (!cleanupLogDir || (!error && ms < SLOW_SWEEP_MS)) {
    return;
  }
  const record = {
    test,
    ms,
    gaveUp: error !== undefined,
    code: error?.code,
    path: error?.path,
    leftovers: error ? leftovers(dir) : undefined,
  };
  try {
    fs.mkdirSync(cleanupLogDir, { recursive: true });
    fs.appendFileSync(
      path.join(cleanupLogDir, `cleanup-${process.pid}-${threadId}.jsonl`),
      `${JSON.stringify(record)}\n`,
    );
  } catch {
    // Diagnostics only.
  }
}

afterEach(async (ctx) => {
  if (currentHome) {
    // Fire-and-forget writes from Session (queue persist, history append)
    // can land mid-rm: as rm walks the tree, a pending mkdir/writeFile
    // recreates a file inside the dir we just emptied and the next rmdir
    // fails with ENOTEMPTY. maxRetries/retryDelay tells Node to retry on
    // exactly that code (also EBUSY/EMFILE/ENFILE/EPERM), which gives
    // those stragglers enough time to land and be swept on the next pass.
    // The retry budget has to cover a loaded CI runner, not just a fast
    // dev box; 5x10ms was enough locally and not on macOS runners.
    //
    // A straggler that outlasts even that budget must not fail a test
    // that already passed, so sweep() swallows it. The per-worker root
    // this lives under is removed wholesale in afterAll, so nothing leaks
    // beyond the run.
    //
    // Six retries (about 1s) and no more: on Windows a file a test left
    // open cannot leave its directory until the handle closes, and a
    // 20-retry budget made each such test wait out 10.5s for nothing.
    const home = currentHome;
    currentHome = undefined;
    await sweep(home, `${ctx.task.file?.name ?? "?"} > ${ctx.task.name}`, 6);
  }
});

afterAll(async () => {
  // Same race as afterEach, one level up: hardening only the per-test
  // sweep just moved the ENOTEMPTY here, where it fails the whole file
  // rather than one test. The root is a mkdtemp under os.tmpdir(), so
  // the worst case of giving up is a directory the OS reaps later.
  await sweep(workerRoot, "(worker root)", 20);
}, 15_000);

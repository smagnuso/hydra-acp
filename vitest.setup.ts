import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
const workerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hydra-acp-vitest-"));

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

afterEach(() => {
  if (currentHome) {
    // Fire-and-forget writes from Session (queue persist, history append)
    // can land mid-rm: as rmSync walks the tree, a pending mkdir/writeFile
    // recreates a file inside the dir we just emptied and the next rmdir
    // fails with ENOTEMPTY. maxRetries/retryDelay tells Node to retry on
    // exactly that code (also EBUSY/EMFILE/ENFILE/EPERM), which gives
    // those stragglers enough time to land and be swept on the next pass.
    fs.rmSync(currentHome, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 10,
    });
    currentHome = undefined;
  }
});

afterAll(() => {
  fs.rmSync(workerRoot, { recursive: true, force: true });
});

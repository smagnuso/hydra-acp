// Test doubles of the classes that write under HYDRA_ACP_HOME, recording
// each instance so settleTracked() can close it and wait out its writes
// before the global afterEach removes the home.
//
// Without this, a session a test never closed keeps appending history and
// rewriting its queue after the test ends. Linux shrugs that off, but on
// Windows a file that is being written cannot leave its directory, so the
// home sweep stalls on ENOTEMPTY.
import { vi } from "vitest";
import { HistoryStore } from "../core/history-store.js";
import { Session } from "../core/session.js";
import { SessionManager } from "../core/session-manager.js";

const sessions = new Set<Session>();
const stores = new Set<HistoryStore>();
const managers = new Set<SessionManager>();

export class TrackedSession extends Session {
  constructor(...args: ConstructorParameters<typeof Session>) {
    super(...args);
    sessions.add(this);
  }
}

export class TrackedHistoryStore extends HistoryStore {
  constructor(...args: ConstructorParameters<typeof HistoryStore>) {
    super(...args);
    stores.add(this);
  }
}

export class TrackedSessionManager extends SessionManager {
  constructor(...args: ConstructorParameters<typeof SessionManager>) {
    super(...args);
    managers.add(this);
  }
}

const SETTLE_STEP_MS = 2_000;

// A close that waits on a mock agent which never answers must not hang teardown.
async function bounded(work: Promise<unknown>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    work.catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SETTLE_STEP_MS);
    }),
  ]);
  clearTimeout(timer);
}

export async function settleTracked(): Promise<void> {
  vi.useRealTimers();
  const liveSessions = [...sessions];
  const liveManagers = [...managers];
  const liveStores = [...stores];
  sessions.clear();
  managers.clear();
  stores.clear();
  await Promise.all(liveManagers.map((m) => bounded(m.closeAll())));
  await Promise.all(liveSessions.map((s) => bounded(s.close({ deleteRecord: false }))));
  await Promise.all(liveSessions.map((s) => bounded(s.flushPersistWrites())));
  await Promise.all(
    liveManagers.map((m) => bounded(Promise.all([m.flushMetaWrites(), m.flushHistoryWrites()]))),
  );
  await Promise.all(liveStores.map((s) => bounded(s.flushAll())));
}

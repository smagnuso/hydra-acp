// Provider lookup by kind.
//
// The default is deliberately `git` rather than "whatever works here".
// Falling back to the copy provider when a directory turns out not to be
// a repository would silently trade a cheap checkout for a full recursive
// directory copy, which on a large tree is a surprising amount of disk
// and time to spend on someone's behalf. A non-repository is a fail-open
// case (run the session unisolated and say why), not a reason to quietly
// pick a costlier strategy. Callers that genuinely want copy semantics
// ask for them by name.

import { CopyProvider, COPY_PROVIDER_KIND } from "./copy-provider.js";
import { GitProvider, GIT_PROVIDER_KIND } from "./git-provider.js";
import type { IsolationProvider } from "./provider.js";

export const DEFAULT_PROVIDER_KIND = GIT_PROVIDER_KIND;

const providers = new Map<string, IsolationProvider>([
  [GIT_PROVIDER_KIND, new GitProvider()],
  [COPY_PROVIDER_KIND, new CopyProvider()],
]);

export function getProvider(kind?: string): IsolationProvider | undefined {
  return providers.get(kind ?? DEFAULT_PROVIDER_KIND);
}

export function providerKinds(): string[] {
  return [...providers.keys()];
}

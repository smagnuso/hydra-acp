// Addressing scheme for a session that lives on a federated peer
// daemon rather than locally: "name:localId", where `name` is the
// local alias chosen at `hydra remote add <name> <host[:port]>` time
// (see peer-store.ts) — never the peer's raw host/port. Safe to split
// on the first colon because peer names are restricted to
// PEER_NAME_PATTERN (no colons) and local session ids (see
// HYDRA_ID_ALPHABET in session-manager.ts) are alphanumeric, so
// neither side of the split can itself contain one.
//
// Used both to decorate a peer's session list when merging it into
// GET /v1/sessions, and to recognize + unpack an incoming id so a
// REST call can be forwarded to the daemon that actually owns it.

export interface ForeignSessionId {
  name: string;
  localId: string;
}

export function formatForeignSessionId(id: ForeignSessionId): string {
  return `${id.name}:${id.localId}`;
}

// Returns undefined for anything that isn't recognizably a foreign
// id — including a bare local id, which never contains a colon — so
// callers can fall through to local handling unchanged.
export function parseForeignSessionId(
  id: string,
): ForeignSessionId | undefined {
  const colon = id.indexOf(":");
  if (colon === -1) {
    return undefined;
  }
  const name = id.slice(0, colon);
  const localId = id.slice(colon + 1);
  if (name.length === 0 || localId.length === 0) {
    return undefined;
  }
  return { name, localId };
}

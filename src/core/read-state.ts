// A session's read state: when its last agent turn ended and when a person
// last looked at it, both epoch ms. See SessionRecord.lastTurnEndedAt.
export interface SessionReadState {
  lastTurnEndedAt?: number;
  readAt?: number;
}

// An absent readAt reads as read: sessions from before read state existed,
// and ones whose first turn has not ended, have nothing new to show.
export function isUnread(
  lastTurnEndedAt: number | undefined,
  readAt: number | undefined,
): boolean {
  return lastTurnEndedAt !== undefined && readAt !== undefined && lastTurnEndedAt > readAt;
}

// The fields a session list row carries for read state.
export function readStateFields(state: SessionReadState): {
  lastTurnEndedAt?: number;
  readAt?: number;
  unread: boolean;
} {
  return {
    ...(state.lastTurnEndedAt !== undefined ? { lastTurnEndedAt: state.lastTurnEndedAt } : {}),
    ...(state.readAt !== undefined ? { readAt: state.readAt } : {}),
    unread: isUnread(state.lastTurnEndedAt, state.readAt),
  };
}

// The readAt that marks a session read as of now, or unread by pulling it
// back behind the last turn's end. Undefined when nothing changes,
// including marking unread a session with no ended turn.
export function nextReadAt(
  state: SessionReadState,
  read: boolean,
  now = Date.now(),
): number | undefined {
  let next: number | undefined;
  if (read) {
    next = Math.max(now, state.lastTurnEndedAt ?? 0);
  } else if (
    state.lastTurnEndedAt !== undefined &&
    !isUnread(state.lastTurnEndedAt, state.readAt)
  ) {
    next = state.lastTurnEndedAt - 1;
  }
  return next === state.readAt ? undefined : next;
}

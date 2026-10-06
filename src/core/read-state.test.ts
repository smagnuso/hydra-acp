import { describe, expect, it } from "vitest";
import { isUnread, nextReadAt, readStateFields } from "./read-state.js";

describe("read state", () => {
  it("is unread only while the last turn ended after readAt", () => {
    expect(isUnread(undefined, undefined)).toBe(false);
    expect(isUnread(100, undefined)).toBe(false);
    expect(isUnread(100, 100)).toBe(false);
    expect(isUnread(100, 99)).toBe(true);
  });

  it("marks read as of now, never behind the last turn", () => {
    expect(nextReadAt({ lastTurnEndedAt: 100, readAt: 50 }, true, 200)).toBe(200);
    expect(nextReadAt({ lastTurnEndedAt: 300, readAt: 50 }, true, 200)).toBe(300);
    expect(nextReadAt({}, true, 200)).toBe(200);
  });

  it("marks unread by pulling readAt behind the last turn", () => {
    expect(nextReadAt({ lastTurnEndedAt: 100, readAt: 150 }, false)).toBe(99);
    expect(nextReadAt({ lastTurnEndedAt: 100 }, false)).toBe(99);
  });

  it("changes nothing when already unread, or with no ended turn to be unread about", () => {
    expect(nextReadAt({ lastTurnEndedAt: 100, readAt: 50 }, false)).toBeUndefined();
    expect(nextReadAt({ readAt: 50 }, false)).toBeUndefined();
    expect(nextReadAt({ lastTurnEndedAt: 100, readAt: 200 }, true, 200)).toBeUndefined();
    expect(nextReadAt({ lastTurnEndedAt: 100, readAt: 150 }, true, 900)).toBeUndefined();
    expect(nextReadAt({ readAt: 150 }, true, 900)).toBeUndefined();
  });

  it("puts only the fields it has on a row", () => {
    expect(readStateFields({})).toEqual({ unread: false });
    expect(readStateFields({ lastTurnEndedAt: 100, readAt: 50 })).toEqual({
      lastTurnEndedAt: 100,
      readAt: 50,
      unread: true,
    });
  });
});

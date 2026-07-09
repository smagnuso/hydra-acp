import { describe, expect, it } from "vitest";
import { LineEditor } from "./line-editor.js";

function typeText(e: LineEditor, s: string): void {
  for (const ch of s) {
    e.handleKey(ch, true);
  }
}

describe("LineEditor", () => {
  it("inserts characters and tracks cursor", () => {
    const e = new LineEditor();
    typeText(e, "hello");
    expect(e.text).toBe("hello");
    expect(e.cursor).toBe(5);
  });

  it("moves cursor left/right and inserts mid-buffer", () => {
    const e = new LineEditor("hello");
    e.moveLeft();
    e.moveLeft();
    expect(e.cursor).toBe(3);
    typeText(e, "X");
    expect(e.text).toBe("helXlo");
    expect(e.cursor).toBe(4);
  });

  it("^A / ^E jump to start / end", () => {
    const e = new LineEditor("abc def");
    e.handleKey("CTRL_A", false);
    expect(e.cursor).toBe(0);
    e.handleKey("CTRL_E", false);
    expect(e.cursor).toBe(7);
  });

  it("HOME / END aliases work", () => {
    const e = new LineEditor("abc");
    e.handleKey("HOME", false);
    expect(e.cursor).toBe(0);
    e.handleKey("END", false);
    expect(e.cursor).toBe(3);
  });

  it("word motion skips whitespace then non-whitespace", () => {
    const e = new LineEditor("foo bar baz");
    e.moveHome();
    e.handleKey("ALT_F", false);
    expect(e.cursor).toBe(3);
    e.handleKey("ALT_F", false);
    expect(e.cursor).toBe(7);
    e.handleKey("ALT_B", false);
    expect(e.cursor).toBe(4);
    e.handleKey("ALT_B", false);
    expect(e.cursor).toBe(0);
  });

  it("backspace and delete-forward", () => {
    const e = new LineEditor("hello");
    e.moveLeft();
    e.handleKey("BACKSPACE", false);
    expect(e.text).toBe("helo");
    expect(e.cursor).toBe(3);
    e.moveHome();
    e.handleKey("DELETE", false);
    expect(e.text).toBe("elo");
    expect(e.cursor).toBe(0);
  });

  it("^U kills from cursor to start", () => {
    const e = new LineEditor("hello world");
    e.moveHome();
    for (let i = 0; i < 6; i++) e.moveRight();
    e.handleKey("CTRL_U", false);
    expect(e.text).toBe("world");
    expect(e.cursor).toBe(0);
  });

  it("^K kills from cursor to end", () => {
    const e = new LineEditor("hello world");
    e.moveHome();
    for (let i = 0; i < 5; i++) e.moveRight();
    e.handleKey("CTRL_K", false);
    expect(e.text).toBe("hello");
    expect(e.cursor).toBe(5);
  });

  it("^W kills previous word", () => {
    const e = new LineEditor("foo bar baz");
    e.handleKey("CTRL_W", false);
    expect(e.text).toBe("foo bar ");
    e.handleKey("CTRL_W", false);
    expect(e.text).toBe("foo ");
    e.handleKey("CTRL_W", false);
    expect(e.text).toBe("");
  });

  it("^Y yanks the last killed text at the cursor", () => {
    const e = new LineEditor("hello world");
    e.moveHome();
    for (let i = 0; i < 5; i++) e.moveRight();
    e.handleKey("CTRL_K", false);
    expect(e.text).toBe("hello");
    e.moveHome();
    e.handleKey("CTRL_Y", false);
    expect(e.text).toBe(" worldhello");
    expect(e.cursor).toBe(6);
  });

  it("undo/redo walk one edit at a time", () => {
    const e = new LineEditor();
    typeText(e, "ab");
    expect(e.text).toBe("ab");
    e.handleKey("\x1f", false);
    expect(e.text).toBe("a");
    e.handleKey("\x1f", false);
    expect(e.text).toBe("");
    e.handleKey("\x1b_", false);
    expect(e.text).toBe("a");
    e.handleKey("\x1b\x1f", false);
    expect(e.text).toBe("ab");
  });

  it("editing after undo drops the redo stack", () => {
    const e = new LineEditor();
    typeText(e, "abc");
    e.handleKey("\x1f", false);
    expect(e.text).toBe("ab");
    typeText(e, "Z");
    expect(e.text).toBe("abZ");
    e.handleKey("\x1b_", false);
    expect(e.text).toBe("abZ");
  });

  it("motion is not undoable", () => {
    const e = new LineEditor("abc");
    e.moveHome();
    e.moveRight();
    e.handleKey("\x1f", false);
    expect(e.text).toBe("abc");
  });

  it("no-op edits (backspace at start, delete at end) do not push undo", () => {
    const e = new LineEditor("");
    e.handleKey("BACKSPACE", false);
    e.handleKey("DELETE", false);
    e.handleKey("\x1f", false);
    expect(e.text).toBe("");
  });

  it("setText replaces buffer and lands cursor at end", () => {
    const e = new LineEditor("abc");
    e.setText("hello world");
    expect(e.text).toBe("hello world");
    expect(e.cursor).toBe(11);
  });

  it("setText with recordUndo makes the swap undoable", () => {
    const e = new LineEditor("abc");
    e.setText("xyz", { recordUndo: true });
    e.handleKey("\x1f", false);
    expect(e.text).toBe("abc");
  });

  it("handleKey returns false on unknown keys", () => {
    const e = new LineEditor("abc");
    expect(e.handleKey("F1", false)).toBe(false);
    expect(e.handleKey("PAGE_UP", false)).toBe(false);
  });

  it("handleKey inserts printables when isCharacter=true", () => {
    const e = new LineEditor();
    expect(e.handleKey("z", true)).toBe(true);
    expect(e.text).toBe("z");
  });
});

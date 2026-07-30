import { describe, expect, it } from "vitest";
import { parseTodoWrite } from "./todos.js";
import { formatEvent } from "../format.js";

const update = (rawInput: unknown): unknown => ({
  sessionUpdate: "tool_call_update",
  toolCallId: "t1",
  title: "todowrite",
  rawInput,
});

describe("parseTodoWrite", () => {
  it("reads a real todowrite payload", () => {
    expect(
      parseTodoWrite(
        update({
          todos: [
            { content: "Extract the module", status: "completed", priority: "high" },
            { content: "Wire it up", status: "in_progress", priority: "high" },
            { content: "Run tests", status: "pending", priority: "medium" },
          ],
        }),
      ),
    ).toEqual([
      { content: "Extract the module", status: "completed", priority: "high" },
      { content: "Wire it up", status: "in_progress", priority: "high" },
      { content: "Run tests", status: "pending", priority: "medium" },
    ]);
  });

  // Null and [] mean different things: null is "this update says nothing
  // about todos, leave the gadget alone", [] is "the agent cleared its
  // list, empty the gadget".
  it("distinguishes 'not a todo payload' from 'an empty list'", () => {
    expect(parseTodoWrite(update({ todos: [] }))).toEqual([]);
    expect(parseTodoWrite(update({ command: "ls" }))).toBeNull();
    expect(parseTodoWrite(update({}))).toBeNull();
  });

  it("returns null for updates with no rawInput at all", () => {
    expect(parseTodoWrite({ sessionUpdate: "tool_call", title: "todowrite" })).toBeNull();
    expect(parseTodoWrite(undefined)).toBeNull();
    expect(parseTodoWrite(null)).toBeNull();
    expect(parseTodoWrite("nope")).toBeNull();
  });

  it("returns null when todos is present but not an array", () => {
    expect(parseTodoWrite(update({ todos: "one, two" }))).toBeNull();
    expect(parseTodoWrite(update({ todos: { a: 1 } }))).toBeNull();
  });

  it("defaults a missing or unrecognized status to pending", () => {
    const out = parseTodoWrite(
      update({
        todos: [
          { content: "no status" },
          { content: "odd status", status: "halfway" },
          { content: "wrong type", status: 3 },
        ],
      }),
    );
    expect(out!.map((e) => e.status)).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
  });

  it("preserves the three known statuses verbatim", () => {
    const out = parseTodoWrite(
      update({
        todos: [
          { content: "a", status: "pending" },
          { content: "b", status: "in_progress" },
          { content: "c", status: "completed" },
        ],
      }),
    );
    expect(out!.map((e) => e.status)).toEqual([
      "pending",
      "in_progress",
      "completed",
    ]);
  });

  it("omits priority when absent or unusable rather than inventing one", () => {
    const out = parseTodoWrite(
      update({
        todos: [
          { content: "a" },
          { content: "b", priority: "" },
          { content: "c", priority: 7 },
        ],
      }),
    );
    expect(out!.every((e) => e.priority === undefined)).toBe(true);
  });

  it("drops entries with no usable content", () => {
    const out = parseTodoWrite(
      update({
        todos: [
          { content: "keep me" },
          { content: "" },
          { content: 42 },
          null,
          "string entry",
        ],
      }),
    );
    expect(out).toEqual([{ content: "keep me", status: "pending" }]);
  });

  it("preserves order", () => {
    const out = parseTodoWrite(
      update({ todos: [{ content: "1" }, { content: "2" }, { content: "3" }] }),
    );
    expect(out!.map((e) => e.content)).toEqual(["1", "2", "3"]);
  });
});

// The transcript renders a task list only from a `plan` RenderEvent, so an
// agent reporting through todowrite gets a block only if this adapter's
// output drops straight into one (app.ts renderPlanBlock). That composition
// is the contract worth pinning: the two shapes have to stay assignable and
// the formatter has to accept the result.
describe("todowrite feeding the transcript plan block", () => {
  it("parses into entries a plan event can be built from and formatted", () => {
    const entries = parseTodoWrite(
      update({
        todos: [
          { content: "Step 1: read the code", status: "completed" },
          { content: "Step 3: per-binding storage", status: "in_progress" },
          { content: "Step 4: tests", status: "pending" },
        ],
      }),
    );
    expect(entries).not.toBeNull();
    const lines = formatEvent(
      { kind: "plan", entries: entries! },
      { maxPlanItems: Infinity },
    );
    const text = lines.map((l) => `${l.prefix ?? ""}${l.body ?? ""}`).join("\n");
    expect(text).toContain("Step 3: per-binding storage");
    expect(text).toContain("Step 1: read the code");
    expect(text).toContain("Step 4: tests");
  });
});

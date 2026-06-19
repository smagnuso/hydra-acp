import { describe, expect, it } from "vitest";
import {
  CLARIFIER_QUESTION_LIST_METHOD,
  CLARIFIER_QUESTION_ANSWER_METHOD,
  CLARIFIER_QUESTION_DISMISS_METHOD,
} from "./clarifier-types.js";

describe("clarifier method-name constants", () => {
  it("CLARIFIER_QUESTION_LIST_METHOD has the correct wire name", () => {
    expect(CLARIFIER_QUESTION_LIST_METHOD).toBe("hydra-acp/question/list");
  });

  it("CLARIFIER_QUESTION_ANSWER_METHOD has the correct wire name", () => {
    expect(CLARIFIER_QUESTION_ANSWER_METHOD).toBe("hydra-acp/question/answer");
  });

  it("CLARIFIER_QUESTION_DISMISS_METHOD has the correct wire name", () => {
    expect(CLARIFIER_QUESTION_DISMISS_METHOD).toBe("hydra-acp/question/dismiss");
  });
});

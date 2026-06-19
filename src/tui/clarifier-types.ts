export type Question = {
  id: string;
  question: string;
  defaultAnswer: string;
  options?: string[];
  askedAt: number;
  askedDuringTurn?: string;
  status: "open" | "pending-delivery" | "closed";
  userAnswer?: string;
  deviated?: boolean;
  closureReason?: "default-accepted" | "deviation-delivered" | "dismissed";
};

export const CLARIFIER_QUESTION_LIST_METHOD = "hydra-acp/question/list";
export const CLARIFIER_QUESTION_ANSWER_METHOD = "hydra-acp/question/answer";
export const CLARIFIER_QUESTION_DISMISS_METHOD = "hydra-acp/question/dismiss";

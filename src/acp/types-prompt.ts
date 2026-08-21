import { z } from "zod";

export const SessionPromptParams = z.object({
  sessionId: z.string(),
  prompt: z.array(z.unknown()),
  // Hydra extensions ride under _meta["hydra-acp"] (e.g. `ancillary` to
  // mark a non-promoting turn). Kept so Session.prompt can read them.
  _meta: z.record(z.unknown()).optional(),
});
export type SessionPromptParams = z.infer<typeof SessionPromptParams>;

export const SessionCancelParams = z.object({
  sessionId: z.string(),
});
export type SessionCancelParams = z.infer<typeof SessionCancelParams>;

// hydra-acp/prompt_queue_* wire shapes. The daemon owns the prompt
// queue per RFD-draft "Prompt Queueing" + visibility extensions; these
// notifications keep all attached clients in sync so any of them can
// render queue chips, cancel a queued entry, or edit it before it runs.

const PromptOriginatorSchema = z.object({
  clientId: z.string(),
  name: z.string().optional(),
  version: z.string().optional(),
});

export const PromptQueueAddedParams = z.object({
  sessionId: z.string(),
  messageId: z.string(),
  originator: PromptOriginatorSchema,
  prompt: z.array(z.unknown()),
  // 0 = head (currently in-flight). At enqueue time the new entry's
  // position equals the count of entries already ahead of it.
  position: z.number().int().nonnegative(),
  queueDepth: z.number().int().positive(),
  enqueuedAt: z.number(),
});
export type PromptQueueAddedParams = z.infer<typeof PromptQueueAddedParams>;

export const PromptQueueUpdatedParams = z.object({
  sessionId: z.string(),
  messageId: z.string(),
  prompt: z.array(z.unknown()),
});
export type PromptQueueUpdatedParams = z.infer<typeof PromptQueueUpdatedParams>;

// `started` = head transitioned to in-flight (the active turn begins).
// `cancelled` = explicit hydra-acp/prompt/cancel. `abandoned` = session
// tear-down with queued entries that never ran.
export const PromptQueueRemovedParams = z.object({
  sessionId: z.string(),
  messageId: z.string(),
  reason: z.enum(["started", "cancelled", "abandoned"]),
});
export type PromptQueueRemovedParams = z.infer<typeof PromptQueueRemovedParams>;

export const CancelPromptParams = z.object({
  sessionId: z.string(),
  messageId: z.string(),
});
export type CancelPromptParams = z.infer<typeof CancelPromptParams>;

// `already_running` means the messageId matched the in-flight head;
// caller should fall back to session/cancel to abort the active turn.
export const CancelPromptResult = z.object({
  cancelled: z.boolean(),
  reason: z.enum(["ok", "not_found", "already_running"]),
});
export type CancelPromptResult = z.infer<typeof CancelPromptResult>;

export const UpdatePromptParams = z.object({
  sessionId: z.string(),
  messageId: z.string(),
  prompt: z.array(z.unknown()),
});
export type UpdatePromptParams = z.infer<typeof UpdatePromptParams>;

export const UpdatePromptResult = z.object({
  updated: z.boolean(),
  reason: z.enum(["ok", "not_found", "already_running"]),
});
export type UpdatePromptResult = z.infer<typeof UpdatePromptResult>;

// hydra-acp/prompt/amend — interrupt the in-flight head turn with a
// replacement prompt. Pin the prompt being amended via targetMessageId
// so the daemon can resolve the race deterministically (the target
// might finish naturally before the amend arrives). For a queued
// target, the daemon edits in place (same machinery as update_prompt).
export const AmendPromptParams = z.object({
  sessionId: z.string(),
  targetMessageId: z.string(),
  prompt: z.array(z.unknown()),
  replaceQueue: z.boolean().optional(),
  onTargetCompleted: z.enum(["reject", "send_anyway"]).optional(),
});
export type AmendPromptParams = z.infer<typeof AmendPromptParams>;

export const AmendPromptResult = z.object({
  amended: z.boolean(),
  reason: z.enum([
    "ok",
    "target_completed",
    "target_cancelled",
    "target_not_found",
  ]),
  // Present when a prompt was sent or replaced: the amendment's id on
  // success, or the regular follow-up's id when onTargetCompleted is
  // "send_anyway" and the daemon forwarded the prompt anyway.
  messageId: z.string().optional(),
});
export type AmendPromptResult = z.infer<typeof AmendPromptResult>;

// _session/steering — the pre-standard mid-turn steering extension
// shipped by claude-agent-acp and codex-acp (the real spec proposal,
// agentclientprotocol/agent-client-protocol#1261, is still open). Shape
// is the union of both adapters': codex-acp's SessionSteerRequest has no
// idleBehavior field at all, claude-agent-acp's carries it under
// _meta.steering.idleBehavior. Hydra never forwards this verbatim to an
// idle session (see Session.steer), so idleBehavior only matters for
// hydra's OWN dispatch decision, not for what an agent receives.
export const SteeringParams = z.object({
  sessionId: z.string(),
  prompt: z.array(z.unknown()),
  _meta: z
    .object({
      steering: z
        .object({
          idleBehavior: z.literal("promptRequired").optional(),
        })
        .optional(),
    })
    .optional(),
});
export type SteeringParams = z.infer<typeof SteeringParams>;

// Union of both adapters' outcome literals. Hydra only ever synthesizes
// "startedNewTurn" (idle-enqueue or amend-cancel-resubmit, both of which
// genuinely start a new turn) or "promptRequired" (idle + the caller
// explicitly asked to have the prompt handed back rather than
// auto-consumed) itself — "injected" and "failed" only ever come from a
// native agent's own reply.
export const SteeringResult = z.object({
  outcome: z.enum(["injected", "startedNewTurn", "promptRequired", "failed"]),
  reason: z.literal("noRunningTurn").optional(),
});
export type SteeringResult = z.infer<typeof SteeringResult>;

// hydra-acp/prompt/amended notification — dedicated linkage event
// fired after a successful amend. Carries both messageIds and the
// amendment content so subscribers that want to render the M1→M2
// relationship don't have to correlate turn_complete + prompt_received
// via _meta or sequence.
export const PromptAmendedParams = z.object({
  sessionId: z.string(),
  cancelledMessageId: z.string(),
  newMessageId: z.string(),
  prompt: z.array(z.unknown()),
  originator: PromptOriginatorSchema,
  amendedAt: z.number(),
});
export type PromptAmendedParams = z.infer<typeof PromptAmendedParams>;

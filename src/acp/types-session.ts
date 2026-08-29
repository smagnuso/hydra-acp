import { z } from "zod";

export const InitializeParams = z.object({
  protocolVersion: z.number().optional(),
  clientCapabilities: z.record(z.unknown()).optional(),
  clientInfo: z
    .object({
      name: z.string(),
      version: z.string().optional(),
    })
    .optional(),
});
export type InitializeParams = z.infer<typeof InitializeParams>;

export const HistoryPolicy = z.enum([
  "full",
  "pending_only",
  "none",
  "after_message",
]);
export type HistoryPolicy = z.infer<typeof HistoryPolicy>;

// Per the ACP spec, NewSessionRequest carries only `cwd` and `mcpServers`.
// Hydra's agent selection rides under `_meta["hydra-acp"].agentId` (parsed
// via extractHydraMeta) rather than a non-spec top-level field.
export const SessionNewParams = z.object({
  cwd: z.string(),
  mcpServers: z.array(z.unknown()).optional(),
  _meta: z.record(z.unknown()).optional(),
});
export type SessionNewParams = z.infer<typeof SessionNewParams>;

export const SessionResumeHints = z.object({
  upstreamSessionId: z.string(),
  agentId: z.string(),
  cwd: z.string(),
  title: z.string().optional(),
  agentArgs: z.array(z.string()).optional(),
});
export type SessionResumeHints = z.infer<typeof SessionResumeHints>;

export const SessionAttachParams = z.object({
  sessionId: z.string(),
  historyPolicy: HistoryPolicy.default("full"),
  // Required when historyPolicy is "after_message"; ignored otherwise.
  // The proxy replays history entries strictly after the entry whose
  // messageId matches this value. If the id isn't found in the buffer,
  // the response.historyPolicy field surfaces "full" so the caller
  // knows we fell back. Per RFD #533.
  //
  // Superseded by afterSeq below, and only sound when the caller received
  // the message whole: messageId names a message, not a frame, so a
  // caller that dropped part-way through one cannot express that here.
  afterMessageId: z.string().optional(),
  // Preferred cursor for "after_message": the `_meta["hydra-acp"].seq` of
  // the last frame the caller processed. Unique per recorded frame, so
  // the resume point is exact — unlike afterMessageId, which is one id
  // shared by every chunk of a streamed reply. Wins over afterMessageId
  // when both are sent. An unknown seq (compacted away, or a caller
  // inventing one) falls back to "full" and says so in
  // response.historyPolicy, same as a missing afterMessageId.
  afterSeq: z.number().optional(),
  // Caller-assigned opaque id (e.g. a UUID). When provided, the proxy
  // echoes it in resolvedBy/sentBy and lifecycle events so other
  // clients can disambiguate multiple instances of the same
  // clientInfo.name. When omitted, the proxy assigns one and returns
  // it in the response. Per RFD #533.
  clientId: z.string().optional(),
  clientInfo: z
    .object({
      name: z.string(),
      version: z.string().optional(),
    })
    .optional(),
  // Hydra-specific attach options (readonly, replayMode, dripSpeed) are
  // NOT top-level — they ride under `_meta["hydra-acp"]` (read via
  // extractHydraMeta) so session/attach carries only RFD #533's own
  // fields at the top level.
  _meta: z.record(z.unknown()).optional(),
});
export type SessionAttachParams = z.infer<typeof SessionAttachParams>;

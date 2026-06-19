import { z } from "zod";

export const AttentionFlagSchema = z.object({
  source: z.string(),
  reason: z.string(),
  raisedAt: z.number(),
  payload: z.unknown(),
});

export type AttentionFlag = z.infer<typeof AttentionFlagSchema>;

export const AttentionFlagArraySchema = z.array(AttentionFlagSchema);

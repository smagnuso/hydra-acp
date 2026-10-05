import { z } from "zod";

// Marks a fork as a side chat: it was branched off a turn of another session for an aside.
// The copied history is context for the agent only; clients show the session from contextThroughSeq on.
export const SideInfoSchema = z.object({
  selection: z
    .object({ text: z.string().min(1), responsePartId: z.string().optional() })
    .optional(),
  contextThroughSeq: z.number().optional(),
});

export type SideInfo = z.infer<typeof SideInfoSchema>;

import { z } from "zod";

import { noNullCharacter, NULL_CHARACTER_MESSAGE } from "./common.js";

export const MAX_MESSAGE_LENGTH = 4000;
// Plafond par ticket : évite qu'un fil de discussion serve à saturer la base ou le budget de l'IA.
export const MAX_MESSAGES_PER_TICKET = 200;

export const createMessageSchema = z
  .object({
    content: z
      .string({ error: "Le message est obligatoire" })
      .trim()
      .min(1, "Le message est obligatoire")
      .max(MAX_MESSAGE_LENGTH, `Le message ne peut pas dépasser ${MAX_MESSAGE_LENGTH} caractères`)
      .refine(noNullCharacter, NULL_CHARACTER_MESSAGE),
  })
  .strict();

export const listMessagesSchema = z
  .object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(50),
  })
  .strict();

export type CreateMessageInput = z.infer<typeof createMessageSchema>;
export type ListMessagesInput = z.infer<typeof listMessagesSchema>;

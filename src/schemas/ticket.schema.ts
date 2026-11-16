import { z } from "zod";

import { noNullCharacter, NULL_CHARACTER_MESSAGE } from "./common.js";

export const ticketStatuses = ["OPEN", "IN_PROGRESS", "CLOSED"] as const;
export const ticketPriorities = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;

const titleSchema = z
  .string({ error: "Le titre est obligatoire" })
  .trim()
  .min(1, "Le titre est obligatoire")
  .max(200, "Le titre ne peut pas dépasser 200 caractères")
  .refine(noNullCharacter, NULL_CHARACTER_MESSAGE);

const descriptionSchema = z
  .string({ error: "La description est obligatoire" })
  .trim()
  .min(1, "La description est obligatoire")
  .refine(noNullCharacter, NULL_CHARACTER_MESSAGE);

const statusSchema = z.enum(ticketStatuses, {
  error: "Le statut doit être OPEN, IN_PROGRESS ou CLOSED",
});

const prioritySchema = z.enum(ticketPriorities, {
  error: "La priorité doit être LOW, MEDIUM, HIGH ou URGENT",
});

export const createTicketSchema = z
  .object({
    title: titleSchema,
    description: descriptionSchema,
    status: statusSchema.default("OPEN"),
    priority: prioritySchema.default("MEDIUM"),
  })
  .strict();

export const replaceTicketSchema = z
  .object({
    title: titleSchema,
    description: descriptionSchema,
    status: statusSchema,
    priority: prioritySchema,
  })
  .strict();

export const updateTicketSchema = replaceTicketSchema
  .partial()
  .refine((data) => Object.keys(data).length > 0, {
    message: "Au moins un champ doit être fourni",
  });

export const ticketSortFields = ["createdAt", "updatedAt", "title", "status", "priority"] as const;

export const listTicketsSchema = z
  .object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(10),
    status: statusSchema.optional(),
    priority: prioritySchema.optional(),
    // Tickets que l'assistant n'a pas su traiter et qui attendent un humain (escaladés et pas encore fermés).
    needsHuman: z.stringbool({ error: "needsHuman doit être true ou false" }).optional(),
    aiHandling: z
      .enum(["NONE", "PENDING", "ANSWERED", "ESCALATED", "OFF_TOPIC"], {
        error: "aiHandling doit être NONE, PENDING, ANSWERED, ESCALATED ou OFF_TOPIC",
      })
      .optional(),
    sortBy: z
      .enum(ticketSortFields, { error: `Le tri doit être l'un de : ${ticketSortFields.join(", ")}` })
      .default("createdAt"),
    order: z.enum(["asc", "desc"], { error: "L'ordre doit être asc ou desc" }).default("desc"),
  })
  .strict();

export const ticketIdSchema = z.object({
  id: z.uuid("L'identifiant du ticket doit être un UUID valide"),
});

export type CreateTicketInput = z.infer<typeof createTicketSchema>;
export type ReplaceTicketInput = z.infer<typeof replaceTicketSchema>;
export type UpdateTicketInput = z.infer<typeof updateTicketSchema>;
export type ListTicketsInput = z.infer<typeof listTicketsSchema>;
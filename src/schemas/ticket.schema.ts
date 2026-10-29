import { z } from "zod";

export const ticketStatuses = ["OPEN", "IN_PROGRESS", "CLOSED"] as const;
export const ticketPriorities = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;

const titleSchema = z
  .string({ error: "Le titre est obligatoire" })
  .trim()
  .min(1, "Le titre est obligatoire")
  .max(200, "Le titre ne peut pas dépasser 200 caractères");

const descriptionSchema = z
  .string({ error: "La description est obligatoire" })
  .trim()
  .min(1, "La description est obligatoire");

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

export const listTicketsSchema = z
  .object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(10),
    status: statusSchema.optional(),
    priority: prioritySchema.optional(),
  })
  .strict();

export const ticketIdSchema = z.object({
  id: z.uuid("L'identifiant du ticket doit être un UUID valide"),
});

export type CreateTicketInput = z.infer<typeof createTicketSchema>;
export type ReplaceTicketInput = z.infer<typeof replaceTicketSchema>;
export type UpdateTicketInput = z.infer<typeof updateTicketSchema>;
export type ListTicketsInput = z.infer<typeof listTicketsSchema>;
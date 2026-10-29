import { z } from "zod";

import { emailSchema } from "./auth.schema.js";

export const assignableRoles = ["ADMIN", "AGENT", "USER"] as const;
export const userStatuses = ["INVITED", "ACTIVE", "DISABLED"] as const;

const roleSchema = z.enum(assignableRoles, {
  error: "Le rôle doit être ADMIN, AGENT ou USER",
});

export const userIdSchema = z.object({
  id: z.uuid("L'identifiant de l'utilisateur doit être un UUID valide"),
});

export const listUsersSchema = z
  .object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(10),
    role: roleSchema.optional(),
    status: z.enum(userStatuses, { error: "Le statut doit être INVITED, ACTIVE ou DISABLED" }).optional(),
    search: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export const updateUserSchema = z
  .object({
    email: emailSchema.optional(),
    role: roleSchema.optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: "Au moins un champ doit être fourni",
  });

export type ListUsersInput = z.infer<typeof listUsersSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

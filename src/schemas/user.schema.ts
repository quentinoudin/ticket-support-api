import { z } from "zod";

import { emailSchema } from "./auth.schema.js";
import { noNullCharacter, NULL_CHARACTER_MESSAGE } from "./common.js";

export const assignableRoles = ["ADMIN", "AGENT", "USER"] as const;
export const userStatuses = ["INVITED", "ACTIVE", "DISABLED"] as const;

const roleSchema = z.enum(assignableRoles, {
  error: "Le rôle doit être ADMIN, AGENT ou USER",
});

export const userIdSchema = z.object({
  id: z.uuid("L'identifiant de l'utilisateur doit être un UUID valide"),
});

export const createUserSchema = z
  .object({
    email: emailSchema,
    role: roleSchema,
  })
  .strict();

export const userSortFields = ["createdAt", "email", "role", "status", "lastLoginAt"] as const;

export const listUsersSchema = z
  .object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(10),
    role: roleSchema.optional(),
    status: z.enum(userStatuses, { error: "Le statut doit être INVITED, ACTIVE ou DISABLED" }).optional(),
    search: z.string().trim().min(1).max(200).refine(noNullCharacter, NULL_CHARACTER_MESSAGE).optional(),
    sortBy: z
      .enum(userSortFields, { error: `Le tri doit être l'un de : ${userSortFields.join(", ")}` })
      .default("createdAt"),
    order: z.enum(["asc", "desc"], { error: "L'ordre doit être asc ou desc" }).default("desc"),
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

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type ListUsersInput = z.infer<typeof listUsersSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

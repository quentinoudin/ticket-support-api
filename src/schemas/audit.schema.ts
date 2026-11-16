import { z } from "zod";

import { auditActions } from "../audit/actions.js";

export const listAuditLogsSchema = z
  .object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
    action: z.enum(auditActions, { error: `L'action doit être l'une de : ${auditActions.join(", ")}` }).optional(),
    actorId: z.uuid("actorId doit être un UUID valide").optional(),
    targetType: z.enum(["User", "Ticket"], { error: "targetType doit être User ou Ticket" }).optional(),
    targetId: z.uuid("targetId doit être un UUID valide").optional(),
    from: z.coerce.date({ error: "from doit être une date valide" }).optional(),
    to: z.coerce.date({ error: "to doit être une date valide" }).optional(),
    order: z.enum(["asc", "desc"], { error: "L'ordre doit être asc ou desc" }).default("desc"),
  })
  .strict();

export type ListAuditLogsInput = z.infer<typeof listAuditLogsSchema>;

import type { AuditAction } from "../audit/actions.js";
import type { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { getRequestContext } from "../lib/request-context.js";
import type { ListAuditLogsInput } from "../schemas/audit.schema.js";

interface AuditEvent {
  action: AuditAction;
  // Par défaut, l'acteur est celui de la requête en cours. À renseigner pour les actions
  // sans utilisateur connecté (échec de connexion, activation d'invitation, reset).
  actor?: { id?: string | null; email?: string | null };
  targetType?: "User" | "Ticket";
  targetId?: string;
  // Jamais de mot de passe, de jeton ni de contenu sensible ici.
  metadata?: Prisma.InputJsonObject;
}

// Une panne du journal ne doit pas faire échouer l'action qu'il décrit : l'erreur est
// affichée côté serveur, et l'action métier continue.
export async function recordAudit(event: AuditEvent): Promise<void> {
  const context = getRequestContext();
  const actor = event.actor ?? context?.actor;

  try {
    await prisma.auditLog.create({
      data: {
        action: event.action,
        actorId: actor?.id ?? null,
        actorEmail: actor?.email ?? null,
        targetType: event.targetType ?? null,
        targetId: event.targetId ?? null,
        metadata: event.metadata ?? undefined,
        ip: context?.ip ?? null,
        userAgent: context?.userAgent ?? null,
      },
    });
  } catch (error) {
    console.error("Échec d'écriture du journal d'audit :", error instanceof Error ? error.message : error);
  }
}

// Compare deux objets et ne garde que les champs qui ont changé : { champ: { from, to } }.
export function diffFields<T extends Record<string, unknown>>(
  before: T,
  after: T,
  fields: readonly (keyof T & string)[],
): Prisma.InputJsonObject {
  const changes: Record<string, { from: unknown; to: unknown }> = {};

  for (const field of fields) {
    if (before[field] !== after[field]) {
      changes[field] = { from: before[field], to: after[field] };
    }
  }

  return changes as Prisma.InputJsonObject;
}

export async function listAuditLogs(filters: ListAuditLogsInput) {
  const { page, limit, action, actorId, targetType, targetId, from, to, order } = filters;

  const where: Prisma.AuditLogWhereInput = {
    ...(action && { action }),
    ...(actorId && { actorId }),
    ...(targetType && { targetType }),
    ...(targetId && { targetId }),
    ...((from || to) && { createdAt: { ...(from && { gte: from }), ...(to && { lte: to }) } }),
  };

  const [logs, total] = await prisma.$transaction([
    prisma.auditLog.findMany({
      where,
      orderBy: [{ createdAt: order }, { id: "asc" }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.auditLog.count({ where }),
  ]);

  return { logs, total };
}

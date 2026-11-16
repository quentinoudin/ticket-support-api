import { escalateTicket } from "../ai/ai.service.js";
import { AppError } from "../errors/app-error.js";
import { prisma } from "../lib/prisma.js";
import type { FeedbackInput } from "../schemas/message.schema.js";
import { recordAudit } from "./audit.service.js";
import { getTicketById } from "./ticket.service.js";
import type { Actor } from "./user.service.js";

// L'auteur du ticket dit si la réponse de l'assistant l'a aidé :
// oui -> le ticket est fermé ; non -> il passe à l'équipe support.
export async function submitFeedback(actor: Actor, ticketId: string, input: FeedbackInput) {
  const ticket = await getTicketById(actor, ticketId);

  // Un agent peut voir le ticket, mais seul son auteur peut dire s'il a été aidé.
  if (ticket.createdById !== actor.id) {
    throw new AppError("Seul l'auteur du ticket peut donner son avis", 403);
  }

  if (ticket.aiHandling !== "ANSWERED" || ticket.status === "CLOSED") {
    throw new AppError("Aucune réponse de l'assistant à évaluer sur ce ticket", 409);
  }

  if (input.resolved) {
    // Mise à jour conditionnelle : deux clics simultanés ne ferment pas deux fois.
    const closed = await prisma.ticket.updateMany({
      where: { id: ticketId, aiHandling: "ANSWERED", status: { not: "CLOSED" } },
      data: { status: "CLOSED" },
    });

    if (closed.count === 0) {
      throw new AppError("Aucune réponse de l'assistant à évaluer sur ce ticket", 409);
    }
  } else if (!(await escalateTicket(ticketId, "USER_NOT_SATISFIED", { from: ["ANSWERED"] }))) {
    throw new AppError("Aucune réponse de l'assistant à évaluer sur ce ticket", 409);
  }

  await recordAudit({
    action: "TICKET_FEEDBACK_SUBMITTED",
    targetType: "Ticket",
    targetId: ticketId,
    metadata: { resolved: input.resolved },
  });

  return prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
}

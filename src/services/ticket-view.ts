import { hasRoleAtLeast } from "../auth/permissions.js";
import type { Ticket, UserRole } from "../generated/prisma/client.js";

// Ce qu'un utilisateur final voit de son ticket. Les champs internes de l'assistant (raisons de
// priorité, catégorie estimée, verrou, motif d'escalade) et l'identifiant de l'auteur restent
// réservés à l'équipe support. `aiHandling` reste visible : l'interface en a besoin pour proposer
// l'avis de l'utilisateur ou la contestation d'un refus hors sujet.
export function presentTicket(ticket: Ticket, viewerRole: UserRole) {
  if (hasRoleAtLeast(viewerRole, "AGENT")) {
    return ticket;
  }

  return {
    id: ticket.id,
    title: ticket.title,
    description: ticket.description,
    status: ticket.status,
    priority: ticket.priority,
    aiHandling: ticket.aiHandling,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
  };
}

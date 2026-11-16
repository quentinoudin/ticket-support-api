import { hasRoleAtLeast } from "../auth/permissions.js";
import { AppError } from "../errors/app-error.js";
import type { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import type {
  CreateTicketInput,
  ListTicketsInput,
  ReplaceTicketInput,
  UpdateTicketInput,
} from "../schemas/ticket.schema.js";
import type { Actor } from "./user.service.js";

const NOT_FOUND = "Ticket introuvable";

// Un USER ne voit que ses propres tickets ; AGENT et au-dessus voient tout.
function visibleTo(actor: Actor): Prisma.TicketWhereInput {
  return hasRoleAtLeast(actor.role, "AGENT") ? {} : { createdById: actor.id };
}

export async function createTicket(actor: Actor, data: CreateTicketInput) {
  return prisma.ticket.create({ data: { ...data, createdById: actor.id } });
}

export async function listTickets(actor: Actor, filters: ListTicketsInput) {
  const { page, limit, status, priority, sortBy, order } = filters;
  const where: Prisma.TicketWhereInput = {
    ...visibleTo(actor),
    ...(status && { status }),
    ...(priority && { priority }),
  };

  const [tickets, total] = await prisma.$transaction([
    prisma.ticket.findMany({
      where,
      // L'identifiant départage les égalités pour que la pagination reste stable.
      orderBy: [{ [sortBy]: order }, { id: "asc" }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.ticket.count({ where }),
  ]);

  return { tickets, total };
}

export async function getTicketById(actor: Actor, id: string) {
  const ticket = await prisma.ticket.findFirst({ where: { id, ...visibleTo(actor) } });

  if (!ticket) {
    throw new AppError(NOT_FOUND, 404);
  }

  return ticket;
}

export async function replaceTicket(id: string, data: ReplaceTicketInput) {
  return prisma.ticket.update({ where: { id }, data });
}

export async function updateTicket(actor: Actor, id: string, data: UpdateTicketInput) {
  // Un USER ne peut modifier que le titre et la description de ses propres tickets.
  if (!hasRoleAtLeast(actor.role, "AGENT")) {
    if (data.status !== undefined || data.priority !== undefined) {
      throw new AppError("Vous ne pouvez pas modifier le statut ou la priorité", 403);
    }

    await getTicketById(actor, id);
  }

  return prisma.ticket.update({ where: { id }, data });
}

export async function deleteTicket(id: string) {
  await prisma.ticket.delete({ where: { id } });
}

import { AppError } from "../errors/app-error.js";
import type { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import type {
  CreateTicketInput,
  ListTicketsInput,
  ReplaceTicketInput,
  UpdateTicketInput,
} from "../schemas/ticket.schema.js";

export async function createTicket(data: CreateTicketInput) {
  return prisma.ticket.create({ data });
}

export async function listTickets(filters: ListTicketsInput) {
  const { page, limit, status, priority } = filters;
  const where: Prisma.TicketWhereInput = {
    ...(status && { status }),
    ...(priority && { priority }),
  };

  const [tickets, total] = await prisma.$transaction([
    prisma.ticket.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.ticket.count({ where }),
  ]);

  return { tickets, total };
}

export async function getTicketById(id: string) {
  const ticket = await prisma.ticket.findUnique({ where: { id } });

  if (!ticket) {
    throw new AppError("Ticket introuvable", 404);
  }

  return ticket;
}

export async function replaceTicket(id: string, data: ReplaceTicketInput) {
  return prisma.ticket.update({ where: { id }, data });
}

export async function updateTicket(id: string, data: UpdateTicketInput) {
  return prisma.ticket.update({ where: { id }, data });
}

export async function deleteTicket(id: string) {
  await prisma.ticket.delete({ where: { id } });
}
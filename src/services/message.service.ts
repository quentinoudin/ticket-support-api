import { onMessageCreated } from "../ai/ai.service.js";
import { hasRoleAtLeast } from "../auth/permissions.js";
import { AppError } from "../errors/app-error.js";
import { prisma } from "../lib/prisma.js";
import {
  MAX_MESSAGES_PER_TICKET,
  type CreateMessageInput,
  type ListMessagesInput,
} from "../schemas/message.schema.js";
import { recordAudit } from "./audit.service.js";
import { getTicketById } from "./ticket.service.js";
import type { Actor } from "./user.service.js";

// Ce qu'on expose d'un message. L'auteur n'est montré qu'à l'équipe support : un utilisateur
// voit qu'un agent a répondu, pas l'identifiant interne de cet agent.
function toPublicMessage(
  message: { id: string; ticketId: string; sender: string; authorId: string | null; content: string; createdAt: Date },
  viewer: Actor,
) {
  return {
    id: message.id,
    ticketId: message.ticketId,
    sender: message.sender,
    content: message.content,
    createdAt: message.createdAt,
    ...(hasRoleAtLeast(viewer.role, "AGENT") && { authorId: message.authorId }),
  };
}

export async function createMessage(actor: Actor, ticketId: string, input: CreateMessageInput) {
  // Même règle de visibilité que le ticket : un USER ne peut écrire que dans les siens (404 sinon).
  const ticket = await getTicketById(actor, ticketId);
  const isStaff = hasRoleAtLeast(actor.role, "AGENT");

  // Un ticket fermé n'accepte plus de message de l'utilisateur, sauf s'il a été fermé par l'assistant
  // comme hors sujet : il doit pouvoir contester. L'équipe support peut toujours écrire.
  if (!isStaff && ticket.status === "CLOSED" && ticket.aiHandling !== "OFF_TOPIC") {
    throw new AppError("Ce ticket est fermé : créez un nouveau ticket pour une nouvelle demande", 409);
  }

  const count = await prisma.ticketMessage.count({ where: { ticketId } });

  if (count >= MAX_MESSAGES_PER_TICKET) {
    throw new AppError("Le nombre maximal de messages pour ce ticket est atteint", 409);
  }

  const message = await prisma.ticketMessage.create({
    data: {
      ticketId,
      sender: isStaff ? "STAFF" : "USER",
      authorId: actor.id,
      content: input.content,
    },
  });

  // Le contenu n'est jamais copié dans le journal : seulement qui a écrit et la taille.
  await recordAudit({
    action: "TICKET_MESSAGE_ADDED",
    targetType: "Ticket",
    targetId: ticketId,
    metadata: { messageId: message.id, sender: message.sender, length: message.content.length },
  });

  // L'assistant réagit : relance, prise de relais humaine, contestation d'un refus hors sujet.
  // Une erreur ici ne doit jamais faire perdre le message que l'utilisateur vient d'envoyer.
  try {
    await onMessageCreated({ id: ticket.id, aiHandling: ticket.aiHandling }, { id: message.id, sender: message.sender });
  } catch (error) {
    console.error("Échec du traitement du message par l'assistant :", error instanceof Error ? error.message : error);
  }

  return { message: toPublicMessage(message, actor), ticket };
}

export async function listMessages(actor: Actor, ticketId: string, filters: ListMessagesInput) {
  await getTicketById(actor, ticketId);

  const { page, limit } = filters;
  const where = { ticketId };

  const [messages, total] = await prisma.$transaction([
    prisma.ticketMessage.findMany({
      where,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.ticketMessage.count({ where }),
  ]);

  return { messages: messages.map((message) => toPublicMessage(message, actor)), total };
}

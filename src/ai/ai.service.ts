import type { z } from "zod";

import type { AiJob, AiRunKind, Prisma, TicketPriority } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { recordAudit } from "../services/audit.service.js";
import { aiConfig } from "./config.js";
import { containsForbiddenContent } from "./guards.js";
import { ESCALATION_NOTICE, OFF_TOPIC_REFUSAL } from "./messages.js";
import { buildReplyMessages } from "./prompts/reply.js";
import { buildTriageMessages } from "./prompts/triage.js";
import { markRunInvalid, runChat } from "./runner.js";
import { parseModelOutput, replyOutputSchema, triageOutputSchema, type TriageOutput } from "./schemas.js";
import type { JobHandlers } from "./worker.js";

// Acteur affiché dans le journal d'audit pour tout ce que fait l'assistant.
export const AI_ACTOR = { id: null, email: "ai-assistant" } as const;

export type EscalationReason =
  | "INVALID_AI_OUTPUT"
  | "OFF_TOPIC_UNSURE"
  | "FORBIDDEN_CONTENT"
  | "NEEDS_HUMAN"
  | "LOW_CONFIDENCE"
  | "AI_ERROR"
  | "BUDGET_EXCEEDED"
  | "USER_QUOTA_EXCEEDED"
  | "MAX_TURNS"
  | "USER_NOT_SATISFIED"
  | "HUMAN_TOOK_OVER"
  | "USER_CONTESTED_OFF_TOPIC";

type Handling = "NONE" | "PENDING" | "ANSWERED" | "ESCALATED" | "OFF_TOPIC";

interface TicketForAi {
  id: string;
  title: string;
  description: string;
  priority: TicketPriority;
  requestedPriority: TicketPriority | null;
  priorityLockedByHuman: boolean;
  aiCategory: string | null;
  createdById: string | null;
}

// Appelle l'IA et valide sa sortie. Une sortie invalide est retentée une fois (le fournisseur
// renvoie parfois du contenu vide ou mal formé en mode JSON), puis abandonnée : on renvoie null.
async function callAndParse<T>(options: {
  kind: AiRunKind;
  messages: Parameters<typeof runChat>[0]["messages"];
  maxTokens: number;
  ticket: Pick<TicketForAi, "id" | "createdById">;
  schema: z.ZodType<T>;
}): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { content, runId } = await runChat({
      kind: options.kind,
      messages: options.messages,
      maxTokens: options.maxTokens,
      ticketId: options.ticket.id,
      userId: options.ticket.createdById,
    });
    const parsed = parseModelOutput(content, options.schema);

    if (parsed.ok) {
      return parsed.data;
    }

    await markRunInvalid(runId);
  }

  return null;
}

// Passe le ticket à l'équipe support. Ne fait rien si le ticket n'est plus dans un état où l'IA
// intervient : on évite ainsi les doubles escalades et les messages en double.
export async function escalateTicket(
  ticketId: string,
  reason: EscalationReason,
  from: Handling[] = ["PENDING", "ANSWERED"],
): Promise<boolean> {
  const updated = await prisma.ticket.updateMany({
    where: { id: ticketId, aiHandling: { in: from } },
    data: { aiHandling: "ESCALATED", aiEscalationReason: reason },
  });

  if (updated.count === 0) {
    return false;
  }

  await prisma.ticketMessage.create({
    data: { ticketId, sender: "AI", authorId: null, content: ESCALATION_NOTICE },
  });

  await recordAudit({
    action: "AI_ESCALATED",
    actor: AI_ACTOR,
    targetType: "Ticket",
    targetId: ticketId,
    metadata: { reason },
  });

  return true;
}

async function closeOffTopic(ticket: TicketForAi, triage: TriageOutput): Promise<void> {
  // Le message de refus est un texte fixe : une injection de prompt ne peut pas le modifier.
  await prisma.$transaction([
    prisma.ticketMessage.create({
      data: { ticketId: ticket.id, sender: "AI", authorId: null, content: OFF_TOPIC_REFUSAL },
    }),
    prisma.ticket.update({
      where: { id: ticket.id },
      data: { status: "CLOSED", aiHandling: "OFF_TOPIC", aiCategory: triage.category, aiPriorityReason: triage.priorityReason },
    }),
  ]);

  await recordAudit({
    action: "AI_OFF_TOPIC_CLOSED",
    actor: AI_ACTOR,
    targetType: "Ticket",
    targetId: ticket.id,
    metadata: { confidence: triage.confidence },
  });
}

// Reclassifie la priorité, sauf si un humain l'a déjà fixée. La priorité demandée par l'utilisateur
// reste dans requestedPriority, et tout changement est journalisé.
async function applyTriage(ticket: TicketForAi, triage: TriageOutput): Promise<void> {
  const changePriority = !ticket.priorityLockedByHuman && triage.priority !== ticket.priority;

  await prisma.ticket.update({
    where: { id: ticket.id },
    data: {
      aiCategory: triage.category,
      aiPriorityReason: triage.priorityReason,
      ...(changePriority && { priority: triage.priority }),
    },
  });

  if (changePriority) {
    await recordAudit({
      action: "AI_PRIORITY_CHANGED",
      actor: AI_ACTOR,
      targetType: "Ticket",
      targetId: ticket.id,
      metadata: {
        priority: { from: ticket.priority, to: triage.priority },
        requestedPriority: ticket.requestedPriority,
        reason: triage.priorityReason,
        confidence: triage.confidence,
      },
    });
  }
}

async function conversationOf(ticketId: string) {
  const messages = await prisma.ticketMessage.findMany({
    where: { ticketId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { sender: true, content: true },
  });

  return messages;
}

// Rédige une réponse. Renvoie true si elle a été publiée, false si le ticket a été escaladé.
export async function replyToTicket(ticket: TicketForAi, category: string | null): Promise<boolean> {
  const reply = await callAndParse({
    kind: "REPLY",
    messages: buildReplyMessages({
      title: ticket.title,
      description: ticket.description,
      category,
      conversation: await conversationOf(ticket.id),
    }),
    maxTokens: aiConfig.maxTokensReply,
    ticket,
    schema: replyOutputSchema,
  });

  if (!reply) {
    await escalateTicket(ticket.id, "INVALID_AI_OUTPUT");
    return false;
  }

  // Un lien ou une adresse dans la réponse est le signe d'une tentative d'hameçonnage : jamais publié.
  if (containsForbiddenContent(reply.reply)) {
    await escalateTicket(ticket.id, "FORBIDDEN_CONTENT");
    return false;
  }

  if (reply.needsHuman) {
    await escalateTicket(ticket.id, "NEEDS_HUMAN");
    return false;
  }

  if (reply.confidence < aiConfig.replyMinConfidence) {
    await escalateTicket(ticket.id, "LOW_CONFIDENCE");
    return false;
  }

  const message = await prisma.ticketMessage.create({
    data: { ticketId: ticket.id, sender: "AI", authorId: null, content: reply.reply },
  });
  await prisma.ticket.update({ where: { id: ticket.id }, data: { aiHandling: "ANSWERED" } });

  await recordAudit({
    action: "AI_REPLIED",
    actor: AI_ACTOR,
    targetType: "Ticket",
    targetId: ticket.id,
    metadata: { messageId: message.id, confidence: reply.confidence } satisfies Prisma.InputJsonObject,
  });

  return true;
}

async function handleTriageAndReply(ticketId: string): Promise<void> {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    select: {
      id: true,
      title: true,
      description: true,
      priority: true,
      requestedPriority: true,
      priorityLockedByHuman: true,
      aiCategory: true,
      createdById: true,
      aiHandling: true,
    },
  });

  // Ticket supprimé, ou déjà traité (tâche rejouée après un arrêt) : rien à faire.
  if (!ticket || ticket.aiHandling !== "PENDING") {
    return;
  }

  const triage = await callAndParse({
    kind: "TRIAGE",
    messages: buildTriageMessages({
      title: ticket.title,
      description: ticket.description,
      requestedPriority: ticket.requestedPriority,
    }),
    maxTokens: aiConfig.maxTokensTriage,
    ticket,
    schema: triageOutputSchema,
  });

  if (!triage) {
    await escalateTicket(ticket.id, "INVALID_AI_OUTPUT");
    return;
  }

  if (!triage.inScope) {
    // On ne ferme un ticket que si l'IA en est très sûre : sinon un humain tranche.
    if (triage.confidence >= aiConfig.offTopicMinConfidence) {
      await closeOffTopic(ticket, triage);
    } else {
      await escalateTicket(ticket.id, "OFF_TOPIC_UNSURE");
    }

    return;
  }

  await applyTriage(ticket, triage);
  await replyToTicket(ticket, triage.category);
}

export async function handleJob(job: AiJob): Promise<void> {
  if (job.type === "TRIAGE_AND_REPLY") {
    await handleTriageAndReply(job.ticketId);
  }
}

// Une tâche qui échoue pour de bon ne doit jamais laisser le ticket sans réponse : un humain le reprend.
export async function handleFinalFailure(job: AiJob, reason: string): Promise<void> {
  const mapped: EscalationReason =
    reason === "BUDGET_EXCEEDED" || reason === "USER_QUOTA_EXCEEDED" ? reason : "AI_ERROR";

  await escalateTicket(job.ticketId, mapped);
}

export const aiJobHandlers: JobHandlers = {
  handle: handleJob,
  onFinalFailure: handleFinalFailure,
};

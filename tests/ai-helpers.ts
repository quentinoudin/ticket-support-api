import { vi } from "vitest";

import { aiConfig } from "../src/ai/config.js";
import { setLlmClient, type ChatRequest, type ChatResult, type LlmClient } from "../src/ai/llm-client.js";
import { prisma } from "../src/lib/prisma.js";

const originalConfig = { ...aiConfig };

// À appeler dans beforeEach/afterEach des tests de l'assistant : remet la configuration d'origine
// et retire le faux client, pour que rien ne fuie d'un test à l'autre.
export function resetAi() {
  Object.assign(aiConfig, originalConfig);
  setLlmClient(undefined);
}

export type FakeReply = string | Error | ((request: ChatRequest) => string | Error);

// Faux fournisseur : renvoie les réponses dans l'ordre, puis la dernière en boucle.
// Ne fait jamais d'appel réseau et enregistre chaque requête reçue.
export function installFakeLlm(...replies: FakeReply[]) {
  const calls: ChatRequest[] = [];
  let index = 0;

  const chat = vi.fn(async (request: ChatRequest): Promise<ChatResult> => {
    calls.push(request);
    const reply = replies[Math.min(index, replies.length - 1)]!;
    index++;
    const outcome = typeof reply === "function" ? reply(request) : reply;

    if (outcome instanceof Error) {
      throw outcome;
    }

    return { content: outcome, promptTokens: 20, completionTokens: 10 };
  });

  const client: LlmClient = { chat };
  setLlmClient(client);

  return { calls, chat };
}

export const triageJson = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    inScope: true,
    category: "PRINTING",
    priority: "MEDIUM",
    priorityReason: "Gêne avec contournement.",
    confidence: 0.9,
    ...overrides,
  });

export const replyJson = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    reply: "Éteignez l'imprimante puis rallumez-la.",
    confidence: 0.8,
    needsHuman: false,
    ...overrides,
  });

export async function createTicketRow(
  createdById: string | null,
  overrides: Partial<{ title: string; description: string; priority: "LOW" | "MEDIUM" | "HIGH" | "URGENT" }> = {},
) {
  return prisma.ticket.create({
    data: {
      title: overrides.title ?? "Imprimante en panne",
      description: overrides.description ?? "Le service compta n'imprime plus.",
      priority: overrides.priority ?? "MEDIUM",
      requestedPriority: overrides.priority ?? "MEDIUM",
      createdById,
    },
  });
}

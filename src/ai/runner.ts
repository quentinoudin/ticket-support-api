import type { AiRunKind } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { AiLimitError, checkLimits } from "./budget.js";
import { aiConfig } from "./config.js";
import { getLlmClient, LlmError, type ChatMessage } from "./llm-client.js";
import { PROMPT_VERSION } from "./prompts/version.js";

interface RunOptions {
  kind: AiRunKind;
  messages: ChatMessage[];
  maxTokens: number;
  ticketId: string;
  // L'auteur du ticket : sert au quota par utilisateur.
  userId: string | null;
}

export interface RunResult {
  content: string;
  runId: string;
}

// Seul endroit où l'application appelle le fournisseur d'IA. Chaque appel passe par les limites
// et laisse une ligne dans AiRun : modèle, version du prompt, jetons, durée, résultat. Jamais le texte.
export async function runChat(options: RunOptions): Promise<RunResult> {
  const { kind, messages, maxTokens, ticketId, userId } = options;
  const base = { kind, model: aiConfig.model, promptVersion: PROMPT_VERSION, ticketId, userId };

  const limits = await checkLimits(userId);

  if (!limits.ok) {
    await prisma.aiRun.create({ data: { ...base, outcome: "BUDGET" } });
    throw new AiLimitError(limits.reason);
  }

  const startedAt = Date.now();

  try {
    const result = await getLlmClient().chat({ messages, maxTokens, json: true });

    const run = await prisma.aiRun.create({
      data: {
        ...base,
        outcome: "OK",
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        latencyMs: Date.now() - startedAt,
      },
    });

    return { content: result.content, runId: run.id };
  } catch (error) {
    const outcome = error instanceof LlmError && error.kind === "timeout" ? "TIMEOUT" : "ERROR";

    await prisma.aiRun.create({ data: { ...base, outcome, latencyMs: Date.now() - startedAt } });
    throw error;
  }
}

// La réponse de l'IA est arrivée mais n'a pas la forme attendue : on corrige le résultat du journal.
export async function markRunInvalid(runId: string): Promise<void> {
  await prisma.aiRun.update({ where: { id: runId }, data: { outcome: "INVALID_OUTPUT" } });
}

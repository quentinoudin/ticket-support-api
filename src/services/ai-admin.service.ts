import { startOfUtcDay, tokensUsedToday } from "../ai/budget.js";
import { aiConfig } from "../ai/config.js";
import { queueStats } from "../ai/jobs.js";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";

// Tableau de bord de l'assistant pour les admins : état, consommation du jour, file d'attente.
// Ne renvoie jamais la clé d'API, seulement le fait qu'elle soit renseignée.
export async function getAiStatus() {
  const since = startOfUtcDay();

  const [tokens, runsByOutcome, queue, ticketsByHandling, waitingForHuman] = await Promise.all([
    tokensUsedToday(),
    prisma.aiRun.groupBy({ by: ["outcome"], where: { createdAt: { gte: since } }, _count: { _all: true } }),
    queueStats(),
    prisma.ticket.groupBy({ by: ["aiHandling"], _count: { _all: true } }),
    prisma.ticket.count({ where: { aiHandling: "ESCALATED", status: { not: "CLOSED" } } }),
  ]);

  return {
    enabled: aiConfig.enabled,
    keyConfigured: Boolean(env.DEEPSEEK_API_KEY),
    model: aiConfig.model,
    budget: {
      dailyTokenBudget: aiConfig.dailyTokenBudget,
      tokensUsedToday: tokens,
      tokensRemaining: Math.max(0, aiConfig.dailyTokenBudget - tokens),
      userDailyRuns: aiConfig.userDailyRuns,
    },
    limits: {
      maxTurns: aiConfig.maxTurns,
      offTopicMinConfidence: aiConfig.offTopicMinConfidence,
      replyMinConfidence: aiConfig.replyMinConfidence,
    },
    runsToday: Object.fromEntries(runsByOutcome.map((row) => [row.outcome, row._count._all])),
    queue,
    tickets: {
      waitingForHuman,
      byAiHandling: Object.fromEntries(ticketsByHandling.map((row) => [row.aiHandling, row._count._all])),
    },
  };
}

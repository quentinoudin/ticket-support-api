import { prisma } from "../lib/prisma.js";
import { aiConfig } from "./config.js";

// Budget et quotas de l'IA. La clé est partagée : ces limites protègent le compte de son propriétaire.

export function startOfUtcDay(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export async function tokensUsedToday(now: Date = new Date()): Promise<number> {
  const result = await prisma.aiRun.aggregate({
    where: { createdAt: { gte: startOfUtcDay(now) } },
    _sum: { promptTokens: true, completionTokens: true },
  });

  return (result._sum.promptTokens ?? 0) + (result._sum.completionTokens ?? 0);
}

// Un appel refusé par le budget ne compte pas dans le quota de l'utilisateur.
export async function userRunsToday(userId: string, now: Date = new Date()): Promise<number> {
  return prisma.aiRun.count({
    where: { userId, createdAt: { gte: startOfUtcDay(now) }, outcome: { not: "BUDGET" } },
  });
}

export type LimitReason = "BUDGET_EXCEEDED" | "USER_QUOTA_EXCEEDED";

export async function checkLimits(userId: string | null, now: Date = new Date()): Promise<{ ok: true } | { ok: false; reason: LimitReason }> {
  if ((await tokensUsedToday(now)) >= aiConfig.dailyTokenBudget) {
    return { ok: false, reason: "BUDGET_EXCEEDED" };
  }

  if (userId && (await userRunsToday(userId, now)) >= aiConfig.userDailyRuns) {
    return { ok: false, reason: "USER_QUOTA_EXCEEDED" };
  }

  return { ok: true };
}

// Levée quand une limite empêche l'appel : l'appelant escalade le ticket vers un humain.
export class AiLimitError extends Error {
  constructor(public readonly reason: LimitReason) {
    super(`Limite de l'assistant IA atteinte (${reason})`);
    this.name = "AiLimitError";
  }
}

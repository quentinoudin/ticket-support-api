import type { AiJob, AiJobType } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";

// File de tâches de l'assistant, stockée dans PostgreSQL : une tâche survit à un redémarrage du
// serveur, et la création d'un ticket n'attend jamais la réponse de l'IA.

export const JOB_MAX_ATTEMPTS = 2;
export const JOB_RETRY_DELAY_MS = 30_000;
// Une tâche « en cours » depuis plus longtemps que ça est considérée comme abandonnée (serveur arrêté).
export const JOB_STALE_AFTER_MS = 5 * 60 * 1000;

export function enqueueJob(job: { type: AiJobType; ticketId: string; messageId?: string }): Promise<AiJob> {
  return prisma.aiJob.create({
    data: { type: job.type, ticketId: job.ticketId, messageId: job.messageId ?? null },
  });
}

// Réserve la plus ancienne tâche prête. Le changement de statut est conditionnel : si deux
// processus se précipitent sur la même tâche, un seul la reçoit.
export async function claimNextJob(now: Date = new Date()): Promise<AiJob | null> {
  const candidate = await prisma.aiJob.findFirst({
    where: { status: "QUEUED", runAfter: { lte: now } },
    orderBy: [{ runAfter: "asc" }, { createdAt: "asc" }],
  });

  if (!candidate) {
    return null;
  }

  const claimed = await prisma.aiJob.updateMany({
    where: { id: candidate.id, status: "QUEUED" },
    data: { status: "RUNNING", lockedAt: now, attempts: { increment: 1 } },
  });

  if (claimed.count === 0) {
    return null;
  }

  return prisma.aiJob.findUniqueOrThrow({ where: { id: candidate.id } });
}

export async function completeJob(id: string): Promise<void> {
  await prisma.aiJob.update({ where: { id }, data: { status: "DONE", lockedAt: null, lastError: null } });
}

// Renvoie true si la tâche sera retentée, false si elle est définitivement en échec.
export async function failJob(
  job: Pick<AiJob, "id" | "attempts">,
  errorCode: string,
  options: { retry?: boolean; now?: Date } = {},
): Promise<boolean> {
  const { retry = true, now = new Date() } = options;
  const willRetry = retry && job.attempts < JOB_MAX_ATTEMPTS;

  await prisma.aiJob.update({
    where: { id: job.id },
    data: willRetry
      ? { status: "QUEUED", lockedAt: null, lastError: errorCode.slice(0, 120), runAfter: new Date(now.getTime() + JOB_RETRY_DELAY_MS) }
      : { status: "FAILED", lockedAt: null, lastError: errorCode.slice(0, 120) },
  });

  return willRetry;
}

// Remet en file les tâches restées « en cours » après un arrêt brutal du serveur.
export async function recoverStaleJobs(now: Date = new Date()): Promise<number> {
  const threshold = new Date(now.getTime() - JOB_STALE_AFTER_MS);
  const stale = await prisma.aiJob.findMany({ where: { status: "RUNNING", lockedAt: { lt: threshold } } });

  for (const job of stale) {
    await failJob(job, "stale_job", { now });
  }

  return stale.length;
}

export async function queueStats() {
  const [queued, running, failed] = await Promise.all([
    prisma.aiJob.count({ where: { status: "QUEUED" } }),
    prisma.aiJob.count({ where: { status: "RUNNING" } }),
    prisma.aiJob.count({ where: { status: "FAILED" } }),
  ]);

  return { queued, running, failed };
}

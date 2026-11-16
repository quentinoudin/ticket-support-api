import type { AiJob } from "../generated/prisma/client.js";
import { AiLimitError } from "./budget.js";
import { aiConfig } from "./config.js";
import { claimNextJob, completeJob, failJob, recoverStaleJobs } from "./jobs.js";
import { LlmError } from "./llm-types.js";

const POLL_INTERVAL_MS = 2000;

export interface JobHandlers {
  // Traite une tâche. Lève une erreur pour la signaler en échec.
  handle: (job: AiJob) => Promise<void>;
  // Appelé quand une tâche ne sera plus retentée : c'est là qu'on escalade le ticket vers un humain,
  // pour qu'une panne de l'IA ne laisse jamais un ticket sans réponse.
  onFinalFailure: (job: AiJob, reason: string) => Promise<void>;
}

function errorCode(error: unknown): string {
  if (error instanceof AiLimitError) {
    return error.reason;
  }

  if (error instanceof LlmError) {
    return `llm_${error.kind}`;
  }

  return "unexpected_error";
}

// Traite au plus une tâche. Renvoie false quand il n'y en a plus de prête.
export async function processNextJob(handlers: JobHandlers, now: Date = new Date()): Promise<boolean> {
  const job = await claimNextJob(now);

  if (!job) {
    return false;
  }

  try {
    await handlers.handle(job);
    await completeJob(job.id);
  } catch (error) {
    const code = errorCode(error);
    // Une limite de budget ne se règle pas en réessayant : on escalade tout de suite.
    const retry = !(error instanceof AiLimitError);
    const willRetry = await failJob(job, code, { retry, now });

    if (!willRetry) {
      await handlers.onFinalFailure(job, code);
    }
  }

  return true;
}

export async function drainJobs(handlers: JobHandlers, now: Date = new Date()): Promise<number> {
  let processed = 0;

  while (await processNextJob(handlers, now)) {
    processed++;
  }

  return processed;
}

let timer: NodeJS.Timeout | undefined;
let running = false;
let current: Promise<void> | undefined;

// Une seule tâche à la fois : l'IA coûte de l'argent, on préfère la lenteur à l'emballement.
export function startAiWorker(handlers: JobHandlers): void {
  if (timer || !aiConfig.enabled) {
    return;
  }

  const tick = async () => {
    if (running) {
      return;
    }

    running = true;

    try {
      await recoverStaleJobs();
      await processNextJob(handlers);
    } catch (error) {
      console.error("Erreur du worker IA :", error instanceof Error ? error.message : error);
    } finally {
      running = false;
    }
  };

  timer = setInterval(() => {
    current = tick();
  }, POLL_INTERVAL_MS);
}

// Arrêt propre : on laisse finir la tâche en cours avant de fermer le serveur.
export async function stopAiWorker(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }

  await current;
}

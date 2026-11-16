import { beforeEach, describe, expect, it, vi } from "vitest";

import { AiLimitError } from "../src/ai/budget.js";
import {
  claimNextJob,
  completeJob,
  enqueueJob,
  failJob,
  JOB_MAX_ATTEMPTS,
  JOB_RETRY_DELAY_MS,
  JOB_STALE_AFTER_MS,
  queueStats,
  recoverStaleJobs,
} from "../src/ai/jobs.js";
import { LlmError } from "../src/ai/llm-types.js";
import { drainJobs, processNextJob, type JobHandlers } from "../src/ai/worker.js";
import { prisma } from "../src/lib/prisma.js";
import { createTicketRow } from "./ai-helpers.js";
import { createUser, resetDatabase } from "./helpers.js";

async function newTicket() {
  const user = await createUser({ role: "USER" });
  return createTicketRow(user.id);
}

beforeEach(resetDatabase);

describe("file de tâches", () => {
  it("réserve les tâches de la plus ancienne à la plus récente", async () => {
    const ticket = await newTicket();
    const now = new Date();
    const first = await enqueueJob({ type: "TRIAGE_AND_REPLY", ticketId: ticket.id });
    const second = await enqueueJob({ type: "FOLLOW_UP", ticketId: ticket.id });

    const claimed = await claimNextJob(new Date(now.getTime() + 1000));
    const next = await claimNextJob(new Date(now.getTime() + 1000));

    expect(claimed!.id).toBe(first.id);
    expect(next!.id).toBe(second.id);
    expect(claimed).toMatchObject({ status: "RUNNING", attempts: 1 });
    expect(claimed!.lockedAt).toBeInstanceOf(Date);
    expect(await claimNextJob(new Date(now.getTime() + 1000))).toBeNull();
  });

  it("n'attribue jamais la même tâche à deux preneurs simultanés", async () => {
    const ticket = await newTicket();
    await enqueueJob({ type: "TRIAGE_AND_REPLY", ticketId: ticket.id });
    const later = new Date(Date.now() + 1000);

    const results = await Promise.all([claimNextJob(later), claimNextJob(later), claimNextJob(later)]);

    expect(results.filter((job) => job !== null)).toHaveLength(1);
  });

  it("ne réserve pas une tâche dont l'heure n'est pas venue", async () => {
    const ticket = await newTicket();
    const job = await enqueueJob({ type: "TRIAGE_AND_REPLY", ticketId: ticket.id });
    await prisma.aiJob.update({ where: { id: job.id }, data: { runAfter: new Date(Date.now() + 60_000) } });

    expect(await claimNextJob()).toBeNull();
  });

  it("marque une tâche terminée", async () => {
    const ticket = await newTicket();
    const job = await enqueueJob({ type: "TRIAGE_AND_REPLY", ticketId: ticket.id });
    await claimNextJob(new Date(Date.now() + 1000));

    await completeJob(job.id);

    expect(await prisma.aiJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
      status: "DONE",
      lockedAt: null,
      lastError: null,
    });
  });

  it("remet une tâche en échec en file avec un délai, puis l'abandonne au maximum de tentatives", async () => {
    const ticket = await newTicket();
    const job = await enqueueJob({ type: "TRIAGE_AND_REPLY", ticketId: ticket.id });
    const now = new Date(Date.now() + 1000);
    const claimed = await claimNextJob(now);

    const willRetry = await failJob(claimed!, "llm_timeout", { now });
    const stored = await prisma.aiJob.findUniqueOrThrow({ where: { id: job.id } });

    expect(willRetry).toBe(true);
    expect(stored).toMatchObject({ status: "QUEUED", lastError: "llm_timeout", lockedAt: null });
    expect(stored.runAfter.getTime()).toBe(now.getTime() + JOB_RETRY_DELAY_MS);
    expect(await claimNextJob(now)).toBeNull();

    const again = await claimNextJob(new Date(now.getTime() + JOB_RETRY_DELAY_MS + 1));
    expect(again!.attempts).toBe(2);
    expect(JOB_MAX_ATTEMPTS).toBe(2);
    expect(await failJob(again!, "llm_timeout")).toBe(false);
    expect((await prisma.aiJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("FAILED");
  });

  it("limite la taille du code d'erreur conservé", async () => {
    const ticket = await newTicket();
    const job = await enqueueJob({ type: "TRIAGE_AND_REPLY", ticketId: ticket.id });
    const claimed = await claimNextJob(new Date(Date.now() + 1000));

    await failJob(claimed!, "x".repeat(500), { retry: false });

    expect((await prisma.aiJob.findUniqueOrThrow({ where: { id: job.id } })).lastError).toHaveLength(120);
  });

  it("récupère les tâches abandonnées par un arrêt brutal, pas celles qui tournent vraiment", async () => {
    const ticket = await newTicket();
    const abandoned = await enqueueJob({ type: "TRIAGE_AND_REPLY", ticketId: ticket.id });
    const active = await enqueueJob({ type: "FOLLOW_UP", ticketId: ticket.id });
    const now = new Date();
    await prisma.aiJob.update({
      where: { id: abandoned.id },
      data: { status: "RUNNING", attempts: 1, lockedAt: new Date(now.getTime() - JOB_STALE_AFTER_MS - 1000) },
    });
    await prisma.aiJob.update({
      where: { id: active.id },
      data: { status: "RUNNING", attempts: 1, lockedAt: new Date(now.getTime() - 1000) },
    });

    const recovered = await recoverStaleJobs(now);

    expect(recovered).toBe(1);
    expect((await prisma.aiJob.findUniqueOrThrow({ where: { id: abandoned.id } })).status).toBe("QUEUED");
    expect((await prisma.aiJob.findUniqueOrThrow({ where: { id: active.id } })).status).toBe("RUNNING");
  });

  it("compte les tâches par état", async () => {
    const ticket = await newTicket();
    await enqueueJob({ type: "TRIAGE_AND_REPLY", ticketId: ticket.id });
    await enqueueJob({ type: "FOLLOW_UP", ticketId: ticket.id });
    const failed = await enqueueJob({ type: "FOLLOW_UP", ticketId: ticket.id });
    await prisma.aiJob.update({ where: { id: failed.id }, data: { status: "FAILED" } });

    expect(await queueStats()).toEqual({ queued: 2, running: 0, failed: 1 });
  });

  it("supprime les tâches avec leur ticket", async () => {
    const ticket = await newTicket();
    await enqueueJob({ type: "TRIAGE_AND_REPLY", ticketId: ticket.id });

    await prisma.ticket.delete({ where: { id: ticket.id } });

    expect(await prisma.aiJob.count()).toBe(0);
  });
});

describe("worker", () => {
  function handlers(handle: JobHandlers["handle"] = async () => {}) {
    const onFinalFailure = vi.fn<JobHandlers["onFinalFailure"]>(async () => {});
    return { handlers: { handle: vi.fn(handle), onFinalFailure }, onFinalFailure };
  }

  const later = () => new Date(Date.now() + 1000);

  it("ne fait rien quand la file est vide", async () => {
    const { handlers: h } = handlers();

    expect(await processNextJob(h, later())).toBe(false);
    expect(h.handle).not.toHaveBeenCalled();
  });

  it("traite les tâches dans l'ordre et les marque terminées", async () => {
    const ticket = await newTicket();
    await enqueueJob({ type: "TRIAGE_AND_REPLY", ticketId: ticket.id });
    await enqueueJob({ type: "FOLLOW_UP", ticketId: ticket.id });
    const order: string[] = [];
    const { handlers: h } = handlers(async (job) => {
      order.push(job.type);
    });

    const processed = await drainJobs(h, later());

    expect(processed).toBe(2);
    expect(order).toEqual(["TRIAGE_AND_REPLY", "FOLLOW_UP"]);
    expect(await prisma.aiJob.count({ where: { status: "DONE" } })).toBe(2);
  });

  it("retente une première fois après une panne de l'IA, sans escalader tout de suite", async () => {
    const ticket = await newTicket();
    await enqueueJob({ type: "TRIAGE_AND_REPLY", ticketId: ticket.id });
    const { handlers: h, onFinalFailure } = handlers(async () => {
      throw new LlmError("timeout");
    });

    await processNextJob(h, later());

    expect(onFinalFailure).not.toHaveBeenCalled();
    expect(await prisma.aiJob.findFirstOrThrow()).toMatchObject({ status: "QUEUED", lastError: "llm_timeout" });
  });

  it("escalade quand les tentatives sont épuisées", async () => {
    const ticket = await newTicket();
    await enqueueJob({ type: "TRIAGE_AND_REPLY", ticketId: ticket.id });
    const { handlers: h, onFinalFailure } = handlers(async () => {
      throw new LlmError("http", 500);
    });
    const first = later();

    await processNextJob(h, first);
    await processNextJob(h, new Date(first.getTime() + JOB_RETRY_DELAY_MS + 1));

    expect(onFinalFailure).toHaveBeenCalledTimes(1);
    expect(onFinalFailure.mock.calls[0]![1]).toBe("llm_http");
    expect((await prisma.aiJob.findFirstOrThrow()).status).toBe("FAILED");
  });

  it("escalade tout de suite quand une limite de budget est atteinte, sans réessayer", async () => {
    const ticket = await newTicket();
    await enqueueJob({ type: "TRIAGE_AND_REPLY", ticketId: ticket.id });
    const { handlers: h, onFinalFailure } = handlers(async () => {
      throw new AiLimitError("BUDGET_EXCEEDED");
    });

    await processNextJob(h, later());

    expect(onFinalFailure).toHaveBeenCalledWith(expect.objectContaining({ ticketId: ticket.id }), "BUDGET_EXCEEDED");
    expect(await prisma.aiJob.findFirstOrThrow()).toMatchObject({ status: "FAILED", attempts: 1 });
  });

  it("ne conserve jamais le message d'une erreur inattendue, qui pourrait contenir des données", async () => {
    const ticket = await newTicket();
    await enqueueJob({ type: "TRIAGE_AND_REPLY", ticketId: ticket.id });
    const { handlers: h } = handlers(async () => {
      throw new Error("Données du ticket : mot de passe wifi 1234");
    });

    await processNextJob(h, later());

    const job = await prisma.aiJob.findFirstOrThrow();
    expect(job.lastError).toBe("unexpected_error");
    expect(JSON.stringify(job)).not.toContain("1234");
  });
});

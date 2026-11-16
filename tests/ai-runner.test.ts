import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AiLimitError, checkLimits, startOfUtcDay, tokensUsedToday, userRunsToday } from "../src/ai/budget.js";
import { aiConfig } from "../src/ai/config.js";
import { LlmError } from "../src/ai/llm-client.js";
import { PROMPT_VERSION } from "../src/ai/prompts/version.js";
import { markRunInvalid, runChat } from "../src/ai/runner.js";
import { prisma } from "../src/lib/prisma.js";
import { installFakeLlm, resetAi } from "./ai-helpers.js";
import { resetDatabase } from "./helpers.js";

beforeEach(async () => {
  await resetDatabase();
  resetAi();
});
afterEach(resetAi);

const messages = [
  { role: "system" as const, content: "Consigne secrète du système" },
  { role: "user" as const, content: "Mon imprimante ne répond plus" },
];

const options = (userId: string | null = randomUUID()) => ({
  kind: "TRIAGE" as const,
  messages,
  maxTokens: 300,
  ticketId: randomUUID(),
  userId,
});

async function seedRun(data: { userId?: string; tokens?: number; createdAt?: Date; outcome?: "OK" | "BUDGET" | "ERROR" }) {
  return prisma.aiRun.create({
    data: {
      kind: "TRIAGE",
      model: "deepseek-flash",
      promptVersion: "test",
      promptTokens: data.tokens ?? 0,
      completionTokens: 0,
      outcome: data.outcome ?? "OK",
      userId: data.userId ?? null,
      createdAt: data.createdAt ?? new Date(),
    },
  });
}

describe("runChat", () => {
  it("appelle l'IA avec les limites configurées et journalise l'appel", async () => {
    const { chat } = installFakeLlm('{"ok":true}');
    const opts = options();

    const result = await runChat(opts);

    expect(result.content).toBe('{"ok":true}');
    expect(chat).toHaveBeenCalledWith({ messages, maxTokens: 300, json: true });

    const run = await prisma.aiRun.findUniqueOrThrow({ where: { id: result.runId } });
    expect(run).toMatchObject({
      kind: "TRIAGE",
      model: aiConfig.model,
      promptVersion: PROMPT_VERSION,
      promptTokens: 20,
      completionTokens: 10,
      outcome: "OK",
      ticketId: opts.ticketId,
      userId: opts.userId,
    });
    expect(run.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("ne stocke jamais le texte des prompts ni des réponses dans le journal", async () => {
    installFakeLlm("Réponse confidentielle de l'IA");

    await runChat(options());

    const everything = JSON.stringify(await prisma.aiRun.findMany());
    expect(everything).not.toContain("imprimante");
    expect(everything).not.toContain("secrète");
    expect(everything).not.toContain("confidentielle");
  });

  it("peut corriger le résultat d'un appel dont la sortie était invalide", async () => {
    installFakeLlm("pas du json");
    const { runId } = await runChat(options());

    await markRunInvalid(runId);

    expect((await prisma.aiRun.findUniqueOrThrow({ where: { id: runId } })).outcome).toBe("INVALID_OUTPUT");
  });

  it("journalise un dépassement de délai en TIMEOUT et relance l'erreur", async () => {
    installFakeLlm(new LlmError("timeout"));

    await expect(runChat(options())).rejects.toMatchObject({ kind: "timeout" });

    expect((await prisma.aiRun.findFirstOrThrow()).outcome).toBe("TIMEOUT");
  });

  it("journalise toute autre panne en ERROR", async () => {
    installFakeLlm(new LlmError("http", 500));

    await expect(runChat(options())).rejects.toBeInstanceOf(LlmError);

    expect((await prisma.aiRun.findFirstOrThrow()).outcome).toBe("ERROR");
  });
});

describe("budget quotidien", () => {
  it("refuse l'appel, sans toucher au fournisseur, quand le budget du jour est atteint", async () => {
    aiConfig.dailyTokenBudget = 100;
    await seedRun({ tokens: 60 });
    await seedRun({ tokens: 40 });
    const { chat } = installFakeLlm("{}");

    await expect(runChat(options())).rejects.toMatchObject({ reason: "BUDGET_EXCEEDED" });

    expect(chat).not.toHaveBeenCalled();
    expect(await prisma.aiRun.count({ where: { outcome: "BUDGET" } })).toBe(1);
  });

  it("laisse passer tant que le budget n'est pas atteint", async () => {
    aiConfig.dailyTokenBudget = 100;
    await seedRun({ tokens: 99 });
    installFakeLlm("{}");

    await expect(runChat(options())).resolves.toBeDefined();
  });

  it("ne compte que les appels du jour (UTC)", async () => {
    aiConfig.dailyTokenBudget = 100;
    const yesterday = new Date(startOfUtcDay().getTime() - 60 * 1000);
    await seedRun({ tokens: 1_000_000, createdAt: yesterday });
    installFakeLlm("{}");

    expect(await tokensUsedToday()).toBe(0);
    await expect(runChat(options())).resolves.toBeDefined();
  });

  it("additionne les jetons d'entrée et de sortie", async () => {
    await prisma.aiRun.create({
      data: { kind: "REPLY", model: "m", promptVersion: "v", promptTokens: 30, completionTokens: 12, outcome: "OK" },
    });

    expect(await tokensUsedToday()).toBe(42);
  });
});

describe("quota par utilisateur", () => {
  it("bloque un utilisateur qui dépasse son quota sans bloquer les autres", async () => {
    aiConfig.userDailyRuns = 2;
    const heavy = randomUUID();
    await seedRun({ userId: heavy });
    await seedRun({ userId: heavy });
    installFakeLlm("{}");

    await expect(runChat(options(heavy))).rejects.toMatchObject({ reason: "USER_QUOTA_EXCEEDED" });
    await expect(runChat(options(randomUUID()))).resolves.toBeDefined();
  });

  it("ne compte pas les appels refusés par le budget dans le quota", async () => {
    aiConfig.userDailyRuns = 2;
    const user = randomUUID();
    await seedRun({ userId: user, outcome: "BUDGET" });
    await seedRun({ userId: user, outcome: "BUDGET" });
    await seedRun({ userId: user, outcome: "BUDGET" });

    expect(await userRunsToday(user)).toBe(0);
    expect(await checkLimits(user)).toEqual({ ok: true });
  });

  it("compte les appels en échec : une panne ne doit pas permettre de réessayer sans fin", async () => {
    aiConfig.userDailyRuns = 1;
    const user = randomUUID();
    await seedRun({ userId: user, outcome: "ERROR" });

    expect(await checkLimits(user)).toEqual({ ok: false, reason: "USER_QUOTA_EXCEEDED" });
  });

  it("n'applique aucun quota quand il n'y a pas d'utilisateur", async () => {
    aiConfig.userDailyRuns = 1;
    await seedRun({ userId: undefined });
    await seedRun({ userId: undefined });

    expect(await checkLimits(null)).toEqual({ ok: true });
  });
});

describe("AiLimitError", () => {
  it("porte la raison et un message sans donnée sensible", () => {
    const error = new AiLimitError("BUDGET_EXCEEDED");

    expect(error.reason).toBe("BUDGET_EXCEEDED");
    expect(error.message).toBe("Limite de l'assistant IA atteinte (BUDGET_EXCEEDED)");
  });
});

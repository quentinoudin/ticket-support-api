import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { aiConfig } from "../src/ai/config.js";
import { app } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { resetAi } from "./ai-helpers.js";
import { createUser, resetDatabase, tokenFor } from "./helpers.js";

beforeEach(async () => {
  await resetDatabase();
  resetAi();
});
afterEach(resetAi);

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

describe("GET /ai/status", () => {
  it("est réservé aux Admin et Super Admin", async () => {
    const agent = await createUser({ email: "agent@test.local", role: "AGENT" });
    const admin = await createUser({ email: "admin@test.local", role: "ADMIN" });
    const user = await createUser({ email: "user@test.local", role: "USER" });
    const superAdmin = await createUser({ email: "root@test.local", role: "SUPER_ADMIN" });

    const results = {
      anonymous: (await request(app).get("/ai/status")).status,
      user: (await request(app).get("/ai/status").set(auth(await tokenFor(user)))).status,
      agent: (await request(app).get("/ai/status").set(auth(await tokenFor(agent)))).status,
      admin: (await request(app).get("/ai/status").set(auth(await tokenFor(admin)))).status,
      superAdmin: (await request(app).get("/ai/status").set(auth(await tokenFor(superAdmin)))).status,
    };

    expect(results).toEqual({ anonymous: 401, user: 403, agent: 403, admin: 200, superAdmin: 200 });
  });

  it("indique l'état, le budget restant, les appels du jour, la file et les tickets en attente d'un humain", async () => {
    const admin = await createUser({ email: "admin@test.local", role: "ADMIN" });
    const owner = await createUser({ email: "owner@test.local", role: "USER" });
    aiConfig.enabled = true;
    aiConfig.dailyTokenBudget = 1000;
    const run = (outcome: "OK" | "ERROR", promptTokens: number) =>
      prisma.aiRun.create({ data: { kind: "TRIAGE", model: "m", promptVersion: "v", promptTokens, completionTokens: 0, outcome } });
    await run("OK", 300);
    await run("OK", 200);
    await run("ERROR", 0);
    const ticket = (aiHandling: "ESCALATED" | "ANSWERED", status: "OPEN" | "CLOSED") =>
      prisma.ticket.create({ data: { title: "t", description: "d", createdById: owner.id, aiHandling, status } });
    const waiting = await ticket("ESCALATED", "OPEN");
    await ticket("ESCALATED", "CLOSED");
    await ticket("ANSWERED", "OPEN");
    await prisma.aiJob.create({ data: { type: "TRIAGE_AND_REPLY", ticketId: waiting.id } });

    const response = await request(app).get("/ai/status").set(auth(await tokenFor(admin)));

    expect(response.body.data).toMatchObject({
      enabled: true,
      model: "deepseek-flash",
      budget: { dailyTokenBudget: 1000, tokensUsedToday: 500, tokensRemaining: 500 },
      runsToday: { OK: 2, ERROR: 1 },
      queue: { queued: 1, running: 0, failed: 0 },
      tickets: { waitingForHuman: 1, byAiHandling: { ESCALATED: 2, ANSWERED: 1 } },
    });
  });

  it("ne renvoie jamais la clé d'API, seulement le fait qu'elle soit renseignée", async () => {
    const admin = await createUser({ email: "admin@test.local", role: "ADMIN" });

    const response = await request(app).get("/ai/status").set(auth(await tokenFor(admin)));

    expect(response.body.data.keyConfigured).toBe(true);
    const body = JSON.stringify(response.body);
    expect(body).not.toContain("cle-factice-pour-les-tests");
    expect(body.toLowerCase()).not.toContain("apikey");
    expect(body).not.toContain("DEEPSEEK_API_KEY");
  });

  it("n'affiche jamais un budget restant négatif", async () => {
    const admin = await createUser({ email: "admin@test.local", role: "ADMIN" });
    aiConfig.dailyTokenBudget = 100;
    await prisma.aiRun.create({
      data: { kind: "TRIAGE", model: "m", promptVersion: "v", promptTokens: 500, completionTokens: 0, outcome: "OK" },
    });

    const response = await request(app).get("/ai/status").set(auth(await tokenFor(admin)));

    expect(response.body.data.budget.tokensRemaining).toBe(0);
  });
});

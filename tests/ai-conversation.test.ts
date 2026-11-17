import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { aiJobHandlers } from "../src/ai/ai.service.js";
import { aiConfig } from "../src/ai/config.js";
import { ESCALATION_NOTICE } from "../src/ai/messages.js";
import { drainJobs } from "../src/ai/worker.js";
import { app } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { installFakeLlm, replyJson, resetAi, triageJson } from "./ai-helpers.js";
import { createUser, resetDatabase, tokenFor } from "./helpers.js";

beforeEach(async () => {
  await resetDatabase();
  resetAi();
  aiConfig.enabled = true;
});
afterEach(resetAi);

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const runJobs = () => drainJobs(aiJobHandlers, new Date(Date.now() + 1000));

async function setup() {
  const owner = await createUser({ email: "owner@test.local", role: "USER" });
  const stranger = await createUser({ email: "stranger@test.local", role: "USER" });
  const agent = await createUser({ email: "agent@test.local", role: "AGENT" });

  return {
    owner,
    ownerToken: await tokenFor(owner),
    strangerToken: await tokenFor(stranger),
    agentToken: await tokenFor(agent),
  };
}

async function createAnsweredTicket(ownerToken: string, firstReply = "Redémarrez la box.") {
  installFakeLlm(triageJson(), replyJson({ reply: firstReply }));
  const created = await request(app)
    .post("/tickets")
    .set(auth(ownerToken))
    .send({ title: "Wifi en panne", description: "Plus de connexion", priority: "HIGH" });
  await runJobs();

  return created.body.data.id as string;
}

const say = (token: string, ticketId: string, content: string) =>
  request(app).post(`/tickets/${ticketId}/messages`).set(auth(token)).send({ content });

const ticketRow = (id: string) => prisma.ticket.findUniqueOrThrow({ where: { id } });
const messagesOf = (id: string) =>
  prisma.ticketMessage.findMany({ where: { ticketId: id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
const auditOf = (action: string) => prisma.auditLog.findMany({ where: { action } });

describe("relances de l'utilisateur", () => {
  it("l'assistant répond aux messages de l'utilisateur en tenant compte de toute la conversation", async () => {
    const { ownerToken } = await setup();
    const ticketId = await createAnsweredTicket(ownerToken);
    const { calls } = installFakeLlm(replyJson({ reply: "Vérifiez que le câble est branché." }));

    await say(ownerToken, ticketId, "Ça ne marche toujours pas.");
    expect(await prisma.aiJob.count({ where: { type: "FOLLOW_UP", status: "QUEUED" } })).toBe(1);
    await runJobs();

    const messages = await messagesOf(ticketId);
    expect(messages.map((message) => [message.sender, message.content])).toEqual([
      ["AI", "Redémarrez la box."],
      ["USER", "Ça ne marche toujours pas."],
      ["AI", "Vérifiez que le câble est branché."],
    ]);
    expect(await ticketRow(ticketId)).toMatchObject({ aiHandling: "ANSWERED", status: "OPEN" });

    const prompt = calls[0]!.messages[1]!.content;
    expect(prompt).toContain("Assistant : Redémarrez la box.");
    expect(prompt).toContain("Utilisateur : Ça ne marche toujours pas.");
    expect(calls).toHaveLength(1);
  });

  it("ne répond qu'une fois quand l'utilisateur envoie deux messages coup sur coup", async () => {
    const { ownerToken } = await setup();
    const ticketId = await createAnsweredTicket(ownerToken);
    const { calls } = installFakeLlm(replyJson({ reply: "Une seule réponse." }));

    await say(ownerToken, ticketId, "Premier message");
    await say(ownerToken, ticketId, "Deuxième message");
    await runJobs();

    expect(calls).toHaveLength(1);
    expect((await messagesOf(ticketId)).filter((message) => message.content === "Une seule réponse.")).toHaveLength(1);
  });

  it("escalade quand l'IA demande un humain pendant la relance", async () => {
    const { ownerToken } = await setup();
    const ticketId = await createAnsweredTicket(ownerToken);
    installFakeLlm(replyJson({ needsHuman: true }));

    await say(ownerToken, ticketId, "Toujours bloqué.");
    await runJobs();

    expect(await ticketRow(ticketId)).toMatchObject({ aiHandling: "ESCALATED", aiEscalationReason: "NEEDS_HUMAN" });
  });

  it("limite le nombre de réponses de l'IA puis passe la main", async () => {
    const { ownerToken } = await setup();
    aiConfig.maxTurns = 2;
    const ticketId = await createAnsweredTicket(ownerToken);
    const { chat } = installFakeLlm(replyJson({ reply: "Deuxième réponse." }));

    await say(ownerToken, ticketId, "Encore un souci.");
    await runJobs();
    expect(await ticketRow(ticketId)).toMatchObject({ aiHandling: "ANSWERED" });

    chat.mockClear();
    await say(ownerToken, ticketId, "Toujours pas résolu.");
    await runJobs();

    expect(chat).not.toHaveBeenCalled();
    expect(await ticketRow(ticketId)).toMatchObject({ aiHandling: "ESCALATED", aiEscalationReason: "MAX_TURNS" });
    expect((await messagesOf(ticketId)).at(-1)!.content).toBe(ESCALATION_NOTICE);
  });

  it("ne déclenche pas de tâche supplémentaire quand l'utilisateur écrit avant la première réponse", async () => {
    const { ownerToken } = await setup();
    const { calls } = installFakeLlm(triageJson(), replyJson());
    const created = await request(app).post("/tickets").set(auth(ownerToken)).send({ title: "Wifi", description: "Panne" });
    const ticketId = created.body.data.id as string;

    await say(ownerToken, ticketId, "J'oubliais : c'est depuis ce matin.");
    expect(await prisma.aiJob.count()).toBe(1);
    await runJobs();

    expect(calls[1]!.messages[1]!.content).toContain("Utilisateur : J'oubliais : c'est depuis ce matin.");
  });

  it("escalade quand l'assistant a été désactivé depuis sa dernière réponse", async () => {
    const { ownerToken } = await setup();
    const ticketId = await createAnsweredTicket(ownerToken);
    aiConfig.enabled = false;

    await say(ownerToken, ticketId, "Une question de plus.");

    expect(await ticketRow(ticketId)).toMatchObject({ aiHandling: "ESCALATED", aiEscalationReason: "AI_DISABLED" });
    expect(await prisma.aiJob.count({ where: { type: "FOLLOW_UP" } })).toBe(0);
  });

  it("ne coûte rien quand le ticket est déjà passé à un humain", async () => {
    const { ownerToken } = await setup();
    const ticketId = await createAnsweredTicket(ownerToken);
    await prisma.ticket.update({ where: { id: ticketId }, data: { aiHandling: "ESCALATED" } });
    const { chat } = installFakeLlm(replyJson());

    await say(ownerToken, ticketId, "Quelqu'un peut m'aider ?");
    await runJobs();

    expect(chat).not.toHaveBeenCalled();
  });
});

describe("prise de relais par l'équipe support", () => {
  it("l'assistant se retire quand un agent écrit, sans message parasite", async () => {
    const { ownerToken, agentToken } = await setup();
    const ticketId = await createAnsweredTicket(ownerToken);

    await say(agentToken, ticketId, "Je m'en occupe.");

    expect(await ticketRow(ticketId)).toMatchObject({ aiHandling: "NONE", aiEscalationReason: "HUMAN_TOOK_OVER" });
    expect((await messagesOf(ticketId)).map((message) => message.sender)).toEqual(["AI", "STAFF"]);
    expect((await auditOf("AI_WITHDRAWN"))[0]).toMatchObject({ actorEmail: "ai-assistant", targetId: ticketId });
  });

  it("ne répond plus aux messages suivants de l'utilisateur", async () => {
    const { ownerToken, agentToken } = await setup();
    const ticketId = await createAnsweredTicket(ownerToken);
    await say(agentToken, ticketId, "Je m'en occupe.");
    const { chat } = installFakeLlm(replyJson());

    await say(ownerToken, ticketId, "Merci !");
    await runJobs();

    expect(chat).not.toHaveBeenCalled();
    expect(await prisma.aiJob.count({ where: { type: "FOLLOW_UP" } })).toBe(0);
  });

  it("annule le traitement d'un ticket encore en attente quand un agent l'a déjà pris", async () => {
    const { ownerToken, agentToken } = await setup();
    const { chat } = installFakeLlm(triageJson(), replyJson());
    const created = await request(app).post("/tickets").set(auth(ownerToken)).send({ title: "Wifi", description: "Panne" });
    const ticketId = created.body.data.id as string;

    await say(agentToken, ticketId, "Je prends ce ticket.");
    await runJobs();

    expect(chat).not.toHaveBeenCalled();
    expect(await ticketRow(ticketId)).toMatchObject({ aiHandling: "NONE" });
  });

  it("un message de l'équipe ne change pas un ticket déjà escaladé", async () => {
    const { ownerToken, agentToken } = await setup();
    const ticketId = await createAnsweredTicket(ownerToken);
    await prisma.ticket.update({ where: { id: ticketId }, data: { aiHandling: "ESCALATED", aiEscalationReason: "NEEDS_HUMAN" } });

    await say(agentToken, ticketId, "Je regarde.");

    expect(await ticketRow(ticketId)).toMatchObject({ aiHandling: "ESCALATED", aiEscalationReason: "NEEDS_HUMAN" });
  });
});

describe("contestation d'un refus hors sujet", () => {
  async function closedOffTopic(ownerToken: string) {
    installFakeLlm(triageJson({ inScope: false, category: "OTHER", confidence: 0.98 }));
    const created = await request(app)
      .post("/tickets")
      .set(auth(ownerToken))
      .send({ title: "Restaurant", description: "Une bonne table ?" });
    await runJobs();

    return created.body.data.id as string;
  }

  it("rouvre le ticket et le passe à un humain quand l'utilisateur répond", async () => {
    const { ownerToken } = await setup();
    const ticketId = await closedOffTopic(ownerToken);
    expect(await ticketRow(ticketId)).toMatchObject({ status: "CLOSED", aiHandling: "OFF_TOPIC" });
    const { chat } = installFakeLlm(replyJson());

    const response = await say(ownerToken, ticketId, "Mon poste est bien en panne, c'est un vrai problème.");
    await runJobs();

    expect(response.status).toBe(201);
    expect(chat).not.toHaveBeenCalled();
    expect(await ticketRow(ticketId)).toMatchObject({
      status: "OPEN",
      aiHandling: "ESCALATED",
      aiEscalationReason: "USER_CONTESTED_OFF_TOPIC",
    });
  });

  it("le ticket réapparaît dans la liste des tickets à traiter par un humain", async () => {
    const { ownerToken, agentToken } = await setup();
    const ticketId = await closedOffTopic(ownerToken);
    await say(ownerToken, ticketId, "C'est bien du support informatique.");

    const response = await request(app).get("/tickets?needsHuman=true").set(auth(agentToken));

    expect(response.body.data.map((ticket: { id: string }) => ticket.id)).toEqual([ticketId]);
  });
});

describe("POST /tickets/:id/feedback", () => {
  it("« résolu » ferme le ticket et le journalise", async () => {
    const { ownerToken } = await setup();
    const ticketId = await createAnsweredTicket(ownerToken);

    const response = await request(app).post(`/tickets/${ticketId}/feedback`).set(auth(ownerToken)).send({ resolved: true });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ status: "CLOSED", aiHandling: "ANSWERED" });
    expect((await auditOf("TICKET_FEEDBACK_SUBMITTED"))[0]!.metadata).toEqual({ resolved: true });
  });

  it("« pas résolu » escalade vers l'équipe support avec un message d'information", async () => {
    const { ownerToken } = await setup();
    const ticketId = await createAnsweredTicket(ownerToken);

    const response = await request(app).post(`/tickets/${ticketId}/feedback`).set(auth(ownerToken)).send({ resolved: false });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ status: "OPEN", aiHandling: "ESCALATED" });
    expect(response.body.data.aiEscalationReason).toBeUndefined();
    expect(await ticketRow(ticketId)).toMatchObject({ aiEscalationReason: "USER_NOT_SATISFIED" });
    expect((await messagesOf(ticketId)).at(-1)!.content).toBe(ESCALATION_NOTICE);
    expect((await auditOf("TICKET_FEEDBACK_SUBMITTED"))[0]!.metadata).toEqual({ resolved: false });
  });

  it("n'est possible qu'une fois", async () => {
    const { ownerToken } = await setup();
    const ticketId = await createAnsweredTicket(ownerToken);

    const first = await request(app).post(`/tickets/${ticketId}/feedback`).set(auth(ownerToken)).send({ resolved: true });
    const second = await request(app).post(`/tickets/${ticketId}/feedback`).set(auth(ownerToken)).send({ resolved: false });

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(await auditOf("TICKET_FEEDBACK_SUBMITTED")).toHaveLength(1);
  });

  it("deux clics simultanés ne produisent qu'un seul avis", async () => {
    const { ownerToken } = await setup();
    const ticketId = await createAnsweredTicket(ownerToken);

    const responses = await Promise.all([
      request(app).post(`/tickets/${ticketId}/feedback`).set(auth(ownerToken)).send({ resolved: false }),
      request(app).post(`/tickets/${ticketId}/feedback`).set(auth(ownerToken)).send({ resolved: false }),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect((await messagesOf(ticketId)).filter((message) => message.content === ESCALATION_NOTICE)).toHaveLength(1);
  });

  it.each(["PENDING", "ESCALATED", "NONE", "OFF_TOPIC"] as const)(
    "refuse (409) quand l'assistant n'a pas répondu (%s)",
    async (handling) => {
      const { ownerToken } = await setup();
      const ticketId = await createAnsweredTicket(ownerToken);
      await prisma.ticket.update({ where: { id: ticketId }, data: { aiHandling: handling } });

      const response = await request(app).post(`/tickets/${ticketId}/feedback`).set(auth(ownerToken)).send({ resolved: true });

      expect(response.status).toBe(409);
    },
  );

  it("est réservé à l'auteur : un agent est refusé (403), un autre utilisateur ne voit pas le ticket (404)", async () => {
    const { ownerToken, strangerToken, agentToken } = await setup();
    const ticketId = await createAnsweredTicket(ownerToken);

    const agent = await request(app).post(`/tickets/${ticketId}/feedback`).set(auth(agentToken)).send({ resolved: true });
    const stranger = await request(app).post(`/tickets/${ticketId}/feedback`).set(auth(strangerToken)).send({ resolved: true });
    const anonymous = await request(app).post(`/tickets/${ticketId}/feedback`).send({ resolved: true });

    expect(agent.status).toBe(403);
    expect(stranger.status).toBe(404);
    expect(anonymous.status).toBe(401);
    expect((await ticketRow(ticketId)).status).toBe("OPEN");
  });

  it.each([{}, { resolved: "true" }, { resolved: 1 }, { resolved: true, status: "CLOSED" }, { resolved: null }])(
    "refuse le corps %j",
    async (body) => {
      const { ownerToken } = await setup();
      const ticketId = await createAnsweredTicket(ownerToken);

      const response = await request(app).post(`/tickets/${ticketId}/feedback`).set(auth(ownerToken)).send(body);

      expect(response.status).toBe(400);
    },
  );
});

describe("filtres de la liste des tickets", () => {
  async function tickets() {
    const { ownerToken, agentToken } = await setup();
    const owner = await prisma.user.findFirstOrThrow({ where: { email: "owner@test.local" } });
    const make = (title: string, data: Record<string, unknown>) =>
      prisma.ticket.create({ data: { title, description: "d", createdById: owner.id, ...data } as never });

    const escalatedOpen = await make("escaladé ouvert", { aiHandling: "ESCALATED", status: "OPEN" });
    const escalatedProgress = await make("escaladé en cours", { aiHandling: "ESCALATED", status: "IN_PROGRESS" });
    const escalatedClosed = await make("escaladé fermé", { aiHandling: "ESCALATED", status: "CLOSED" });
    const answered = await make("répondu", { aiHandling: "ANSWERED" });
    const none = await make("sans IA", { aiHandling: "NONE" });

    return { ownerToken, agentToken, escalatedOpen, escalatedProgress, escalatedClosed, answered, none };
  }

  const ids = (response: request.Response) => response.body.data.map((ticket: { id: string }) => ticket.id).sort();

  it("needsHuman=true ne montre que les tickets escaladés pas encore fermés", async () => {
    const { agentToken, escalatedOpen, escalatedProgress } = await tickets();

    const response = await request(app).get("/tickets?needsHuman=true").set(auth(agentToken));

    expect(ids(response)).toEqual([escalatedOpen.id, escalatedProgress.id].sort());
  });

  it("needsHuman=false montre tous les autres", async () => {
    const { agentToken, escalatedClosed, answered, none } = await tickets();

    const response = await request(app).get("/tickets?needsHuman=false").set(auth(agentToken));

    expect(ids(response)).toEqual([escalatedClosed.id, answered.id, none.id].sort());
  });

  it("aiHandling filtre par état et se combine aux autres filtres", async () => {
    const { agentToken, escalatedProgress } = await tickets();

    const response = await request(app).get("/tickets?aiHandling=ESCALATED&status=IN_PROGRESS").set(auth(agentToken));

    expect(ids(response)).toEqual([escalatedProgress.id]);
  });

  it("un USER ne voit que ses propres tickets, même avec le filtre", async () => {
    const { ownerToken } = await tickets();
    const intruder = await createUser({ email: "autre@test.local", role: "USER" });
    await prisma.ticket.create({ data: { title: "autre", description: "d", createdById: intruder.id, aiHandling: "ESCALATED" } });

    const response = await request(app).get("/tickets?needsHuman=true").set(auth(ownerToken));

    expect(response.body.data).toHaveLength(2);
  });

  it("refuse une valeur invalide", async () => {
    const { agentToken } = await tickets();

    for (const query of ["needsHuman=peut-être", "aiHandling=INCONNU", "aiHandling=ESCALATED'; DROP TABLE \"Ticket\"; --"]) {
      const response = await request(app).get(`/tickets?${encodeURI(query)}`).set(auth(agentToken));
      expect(response.status).toBe(400);
    }
    expect(await prisma.ticket.count()).toBe(5);
  });
});

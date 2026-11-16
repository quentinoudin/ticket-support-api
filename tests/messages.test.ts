import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import { app } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { MAX_MESSAGES_PER_TICKET } from "../src/schemas/message.schema.js";
import { createUser, resetDatabase, tokenFor } from "./helpers.js";

beforeEach(resetDatabase);

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function setup() {
  const owner = await createUser({ email: "owner@test.local", role: "USER" });
  const stranger = await createUser({ email: "stranger@test.local", role: "USER" });
  const agent = await createUser({ email: "agent@test.local", role: "AGENT" });
  const ownerToken = await tokenFor(owner);
  const ticket = await request(app)
    .post("/tickets")
    .set(auth(ownerToken))
    .send({ title: "Wifi en panne", description: "Plus de connexion" });

  return {
    owner,
    agent,
    ownerToken,
    strangerToken: await tokenFor(stranger),
    agentToken: await tokenFor(agent),
    ticketId: ticket.body.data.id as string,
  };
}

describe("POST /tickets/:id/messages", () => {
  it("un USER écrit dans son propre ticket", async () => {
    const { ownerToken, ticketId } = await setup();

    const response = await request(app)
      .post(`/tickets/${ticketId}/messages`)
      .set(auth(ownerToken))
      .send({ content: "  Toujours rien après le redémarrage.  " });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      ticketId,
      sender: "USER",
      content: "Toujours rien après le redémarrage.",
    });
    expect(response.body.data.authorId).toBeUndefined();
  });

  it("un AGENT écrit comme équipe support, dans n'importe quel ticket", async () => {
    const { agentToken, agent, ticketId } = await setup();

    const response = await request(app)
      .post(`/tickets/${ticketId}/messages`)
      .set(auth(agentToken))
      .send({ content: "Je prends ce ticket en charge." });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({ sender: "STAFF", authorId: agent.id });
  });

  it("un USER ne peut pas écrire dans le ticket d'un autre (404)", async () => {
    const { strangerToken, ticketId } = await setup();

    const response = await request(app)
      .post(`/tickets/${ticketId}/messages`)
      .set(auth(strangerToken))
      .send({ content: "Je me permets d'intervenir" });

    expect(response.status).toBe(404);
    expect(await prisma.ticketMessage.count()).toBe(0);
  });

  it("exige une connexion", async () => {
    const { ticketId } = await setup();

    const response = await request(app).post(`/tickets/${ticketId}/messages`).send({ content: "Bonjour" });

    expect(response.status).toBe(401);
  });

  it.each([
    ["vide", { content: "" }],
    ["fait d'espaces", { content: "   " }],
    ["absent", {}],
    ["trop long", { content: "x".repeat(4001) }],
    ["avec un caractère nul", { content: "a\u0000b" }],
    ["pas du texte", { content: { $ne: null } }],
    ["avec un champ en trop", { content: "Bonjour", sender: "STAFF" }],
  ])("refuse un message %s", async (_label, body) => {
    const { ownerToken, ticketId } = await setup();

    const response = await request(app).post(`/tickets/${ticketId}/messages`).set(auth(ownerToken)).send(body);

    expect(response.status).toBe(400);
    expect(await prisma.ticketMessage.count()).toBe(0);
  });

  it("ne laisse pas un USER se faire passer pour l'équipe support ou pour l'IA", async () => {
    const { ownerToken, ticketId } = await setup();

    await request(app).post(`/tickets/${ticketId}/messages`).set(auth(ownerToken)).send({ content: "Bonjour", sender: "AI" });
    const stored = await request(app).post(`/tickets/${ticketId}/messages`).set(auth(ownerToken)).send({ content: "Bonjour" });

    expect(stored.body.data.sender).toBe("USER");
  });

  it("refuse l'identifiant d'un ticket invalide ou inexistant", async () => {
    const { ownerToken } = await setup();

    const invalid = await request(app).post("/tickets/pas-un-uuid/messages").set(auth(ownerToken)).send({ content: "x" });
    const missing = await request(app)
      .post("/tickets/00000000-0000-4000-8000-000000000000/messages")
      .set(auth(ownerToken))
      .send({ content: "x" });

    expect(invalid.status).toBe(400);
    expect(missing.status).toBe(404);
  });

  describe("ticket fermé", () => {
    it("refuse un nouveau message de l'utilisateur (409) mais accepte l'équipe support", async () => {
      const { ownerToken, agentToken, ticketId } = await setup();
      await prisma.ticket.update({ where: { id: ticketId }, data: { status: "CLOSED" } });

      const user = await request(app).post(`/tickets/${ticketId}/messages`).set(auth(ownerToken)).send({ content: "Encore moi" });
      const staff = await request(app).post(`/tickets/${ticketId}/messages`).set(auth(agentToken)).send({ content: "Note interne" });

      expect(user.status).toBe(409);
      expect(staff.status).toBe(201);
    });

    it("accepte l'utilisateur quand l'assistant a fermé son ticket comme hors sujet, pour qu'il conteste", async () => {
      const { ownerToken, ticketId } = await setup();
      await prisma.ticket.update({ where: { id: ticketId }, data: { status: "CLOSED", aiHandling: "OFF_TOPIC" } });

      const response = await request(app)
        .post(`/tickets/${ticketId}/messages`)
        .set(auth(ownerToken))
        .send({ content: "C'est bien un problème informatique." });

      expect(response.status).toBe(201);
    });
  });

  it("plafonne le nombre de messages par ticket", async () => {
    const { ownerToken, owner, ticketId } = await setup();
    await prisma.ticketMessage.createMany({
      data: Array.from({ length: MAX_MESSAGES_PER_TICKET }, (_, i) => ({
        ticketId,
        sender: "USER" as const,
        authorId: owner.id,
        content: `message ${i}`,
      })),
    });

    const response = await request(app).post(`/tickets/${ticketId}/messages`).set(auth(ownerToken)).send({ content: "de trop" });

    expect(response.status).toBe(409);
    expect(await prisma.ticketMessage.count()).toBe(MAX_MESSAGES_PER_TICKET);
  });

  it("est journalisé sans jamais copier le contenu du message", async () => {
    const { ownerToken, owner, ticketId } = await setup();

    const created = await request(app)
      .post(`/tickets/${ticketId}/messages`)
      .set(auth(ownerToken))
      .send({ content: "Contenu très confidentiel" });

    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "TICKET_MESSAGE_ADDED" } });
    expect(log).toMatchObject({
      actorId: owner.id,
      targetId: ticketId,
      metadata: { messageId: created.body.data.id, sender: "USER", length: 25 },
    });
    expect(JSON.stringify(await prisma.auditLog.findMany())).not.toContain("confidentiel");
  });
});

describe("GET /tickets/:id/messages", () => {
  it("liste le fil dans l'ordre chronologique avec pagination", async () => {
    const { ownerToken, agentToken, ticketId } = await setup();
    for (const [token, content] of [
      [ownerToken, "Premier"],
      [agentToken, "Deuxième"],
      [ownerToken, "Troisième"],
    ] as const) {
      await request(app).post(`/tickets/${ticketId}/messages`).set(auth(token)).send({ content });
    }

    const all = await request(app).get(`/tickets/${ticketId}/messages`).set(auth(ownerToken));
    const page = await request(app).get(`/tickets/${ticketId}/messages?limit=1&page=2`).set(auth(ownerToken));

    expect(all.body.data.map((m: { content: string }) => m.content)).toEqual(["Premier", "Deuxième", "Troisième"]);
    expect(all.body.data.map((m: { sender: string }) => m.sender)).toEqual(["USER", "STAFF", "USER"]);
    expect(page.body.data.map((m: { content: string }) => m.content)).toEqual(["Deuxième"]);
    expect(page.body.pagination).toMatchObject({ total: 3, totalPages: 3, page: 2 });
  });

  it("cache l'identifiant des auteurs à l'utilisateur, pas à l'équipe support", async () => {
    const { ownerToken, agentToken, ticketId } = await setup();
    await request(app).post(`/tickets/${ticketId}/messages`).set(auth(agentToken)).send({ content: "Bonjour" });

    const asOwner = await request(app).get(`/tickets/${ticketId}/messages`).set(auth(ownerToken));
    const asAgent = await request(app).get(`/tickets/${ticketId}/messages`).set(auth(agentToken));

    expect(asOwner.body.data[0].authorId).toBeUndefined();
    expect(asAgent.body.data[0].authorId).toEqual(expect.any(String));
  });

  it("un autre USER ne voit rien (404), un AGENT voit tout", async () => {
    const { strangerToken, agentToken, ownerToken, ticketId } = await setup();
    await request(app).post(`/tickets/${ticketId}/messages`).set(auth(ownerToken)).send({ content: "Bonjour" });

    const stranger = await request(app).get(`/tickets/${ticketId}/messages`).set(auth(strangerToken));
    const agent = await request(app).get(`/tickets/${ticketId}/messages`).set(auth(agentToken));

    expect(stranger.status).toBe(404);
    expect(agent.body.data).toHaveLength(1);
  });

  it("refuse une pagination invalide", async () => {
    const { ownerToken, ticketId } = await setup();

    for (const query of ["page=0", "limit=101", "limit=abc", "sort=desc"]) {
      const response = await request(app).get(`/tickets/${ticketId}/messages?${query}`).set(auth(ownerToken));
      expect(response.status).toBe(400);
    }
  });

  it("les messages disparaissent avec le ticket", async () => {
    const { ownerToken, agentToken, ticketId } = await setup();
    await request(app).post(`/tickets/${ticketId}/messages`).set(auth(ownerToken)).send({ content: "Bonjour" });
    const admin = await createUser({ email: "admin@test.local", role: "ADMIN" });

    await request(app).delete(`/tickets/${ticketId}`).set(auth(await tokenFor(admin)));

    expect(await prisma.ticketMessage.count()).toBe(0);
    expect(agentToken).toBeDefined();
  });
});

import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import { app } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { createUser, resetDatabase, tokenFor } from "./helpers.js";

beforeEach(resetDatabase);

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const body = { title: "Imprimante en panne", description: "Compta", priority: "HIGH" };

async function setup() {
  const owner = await createUser({ email: "owner@test.local", role: "USER" });
  const other = await createUser({ email: "other@test.local", role: "USER" });
  const agent = await createUser({ email: "agent@test.local", role: "AGENT" });
  const admin = await createUser({ email: "admin@test.local", role: "ADMIN" });
  const superAdmin = await createUser({ email: "root@test.local", role: "SUPER_ADMIN" });

  return {
    owner,
    ownerToken: await tokenFor(owner),
    otherToken: await tokenFor(other),
    agentToken: await tokenFor(agent),
    adminToken: await tokenFor(admin),
    superToken: await tokenFor(superAdmin),
  };
}

async function createTicket(token: string) {
  const response = await request(app).post("/tickets").set(auth(token)).send(body);
  return response.body.data.id as string;
}

describe("authentification des tickets", () => {
  it("refuse toutes les routes sans jeton, mais /health reste public", async () => {
    const anonymous = await Promise.all([
      request(app).get("/tickets"),
      request(app).post("/tickets").send(body),
      request(app).get("/tickets/00000000-0000-4000-8000-000000000000"),
      request(app).delete("/tickets/00000000-0000-4000-8000-000000000000"),
    ]);
    const health = await request(app).get("/health");

    expect(anonymous.map((r) => r.status)).toEqual([401, 401, 401, 401]);
    expect(health.status).toBe(200);
  });
});

describe("création", () => {
  it("enregistre l'auteur du ticket", async () => {
    const { ownerToken, owner } = await setup();

    const response = await request(app).post("/tickets").set(auth(ownerToken)).send(body);

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({ status: "OPEN", priority: "HIGH", createdById: owner.id });
  });

  it("refuse un createdById fourni par le client", async () => {
    const { ownerToken } = await setup();

    const response = await request(app)
      .post("/tickets")
      .set(auth(ownerToken))
      .send({ ...body, createdById: "00000000-0000-4000-8000-000000000000" });

    expect(response.status).toBe(400);
  });
});

describe("lecture", () => {
  it("un USER ne voit que ses propres tickets", async () => {
    const { ownerToken, otherToken } = await setup();
    const mine = await createTicket(ownerToken);
    const theirs = await createTicket(otherToken);

    const list = await request(app).get("/tickets").set(auth(ownerToken));
    const own = await request(app).get(`/tickets/${mine}`).set(auth(ownerToken));
    const foreign = await request(app).get(`/tickets/${theirs}`).set(auth(ownerToken));

    expect(list.body.data.map((t: { id: string }) => t.id)).toEqual([mine]);
    expect(list.body.pagination.total).toBe(1);
    expect(own.status).toBe(200);
    expect(foreign.status).toBe(404);
  });

  it("AGENT, ADMIN et SUPER_ADMIN voient tous les tickets, filtres compris", async () => {
    const { ownerToken, otherToken, agentToken, adminToken, superToken } = await setup();
    await createTicket(ownerToken);
    await createTicket(otherToken);

    for (const token of [agentToken, adminToken, superToken]) {
      const response = await request(app).get("/tickets?priority=HIGH&status=OPEN").set(auth(token));
      expect(response.body.pagination.total).toBe(2);
    }
  });
});

describe("modification", () => {
  it("un USER modifie titre et description de son ticket, pas le statut ni la priorité", async () => {
    const { ownerToken } = await setup();
    const id = await createTicket(ownerToken);

    const allowed = await request(app).patch(`/tickets/${id}`).set(auth(ownerToken)).send({ title: "Nouveau titre" });
    const forbidden = await request(app).patch(`/tickets/${id}`).set(auth(ownerToken)).send({ status: "CLOSED" });

    expect(allowed.status).toBe(200);
    expect(allowed.body.data.title).toBe("Nouveau titre");
    expect(forbidden.status).toBe(403);
  });

  it("un USER ne peut pas modifier le ticket d'un autre (404)", async () => {
    const { ownerToken, otherToken } = await setup();
    const id = await createTicket(otherToken);

    const response = await request(app).patch(`/tickets/${id}`).set(auth(ownerToken)).send({ title: "Piraté" });

    expect(response.status).toBe(404);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id } })).title).toBe(body.title);
  });

  it("un AGENT modifie tous les champs, y compris le statut", async () => {
    const { ownerToken, agentToken } = await setup();
    const id = await createTicket(ownerToken);

    const response = await request(app)
      .patch(`/tickets/${id}`)
      .set(auth(agentToken))
      .send({ status: "IN_PROGRESS", priority: "URGENT" });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ status: "IN_PROGRESS", priority: "URGENT" });
  });

  it("PUT est réservé à AGENT et au-dessus", async () => {
    const { ownerToken, agentToken } = await setup();
    const id = await createTicket(ownerToken);
    const full = { title: "T2", description: "D2", status: "CLOSED", priority: "LOW" };

    const asUser = await request(app).put(`/tickets/${id}`).set(auth(ownerToken)).send(full);
    const asAgent = await request(app).put(`/tickets/${id}`).set(auth(agentToken)).send(full);

    expect(asUser.status).toBe(403);
    expect(asAgent.status).toBe(200);
  });
});

describe("suppression", () => {
  it("est réservée à ADMIN et au-dessus", async () => {
    const { ownerToken, agentToken, adminToken, superToken } = await setup();
    const id = await createTicket(ownerToken);

    const asUser = await request(app).delete(`/tickets/${id}`).set(auth(ownerToken));
    const asAgent = await request(app).delete(`/tickets/${id}`).set(auth(agentToken));
    const asAdmin = await request(app).delete(`/tickets/${id}`).set(auth(adminToken));
    const again = await request(app).delete(`/tickets/${id}`).set(auth(superToken));

    expect(asUser.status).toBe(403);
    expect(asAgent.status).toBe(403);
    expect(asAdmin.status).toBe(204);
    expect(again.status).toBe(404);
  });

  it("garde les tickets quand leur auteur est supprimé", async () => {
    const { ownerToken, owner, superToken } = await setup();
    const id = await createTicket(ownerToken);

    await request(app).delete(`/users/${owner.id}`).set(auth(superToken));

    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id } });
    expect(ticket.createdById).toBeNull();
  });
});

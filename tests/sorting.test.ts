import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import { app } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { createUser, resetDatabase, tokenFor } from "./helpers.js";

beforeEach(resetDatabase);

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function agentWithTickets() {
  const agent = await createUser({ email: "agent@test.local", role: "AGENT" });
  const base = new Date("2026-01-01T10:00:00Z").getTime();
  const tickets = [
    { title: "Banane", status: "CLOSED", priority: "LOW" },
    { title: "Abricot", status: "OPEN", priority: "URGENT" },
    { title: "Cerise", status: "IN_PROGRESS", priority: "HIGH" },
    { title: "Datte", status: "OPEN", priority: "MEDIUM" },
  ] as const;

  for (const [index, ticket] of tickets.entries()) {
    await prisma.ticket.create({
      data: { ...ticket, description: "d", createdById: agent.id, createdAt: new Date(base + index * 1000) },
    });
  }

  return tokenFor(agent);
}

const titles = (response: request.Response) => response.body.data.map((t: { title: string }) => t.title);

describe("tri des tickets", () => {
  it("trie par défaut du plus récent au plus ancien", async () => {
    const token = await agentWithTickets();

    const response = await request(app).get("/tickets").set(auth(token));

    expect(titles(response)).toEqual(["Datte", "Cerise", "Abricot", "Banane"]);
  });

  it("trie par titre dans les deux sens", async () => {
    const token = await agentWithTickets();

    const asc = await request(app).get("/tickets?sortBy=title&order=asc").set(auth(token));
    const desc = await request(app).get("/tickets?sortBy=title&order=desc").set(auth(token));

    expect(titles(asc)).toEqual(["Abricot", "Banane", "Cerise", "Datte"]);
    expect(titles(desc)).toEqual(["Datte", "Cerise", "Banane", "Abricot"]);
  });

  it("trie la priorité par gravité (LOW < MEDIUM < HIGH < URGENT), pas par ordre alphabétique", async () => {
    const token = await agentWithTickets();

    const response = await request(app).get("/tickets?sortBy=priority&order=desc").set(auth(token));

    expect(titles(response)).toEqual(["Abricot", "Cerise", "Datte", "Banane"]);
  });

  it("se combine avec les filtres et la pagination", async () => {
    const token = await agentWithTickets();

    const response = await request(app)
      .get("/tickets?status=OPEN&sortBy=title&order=asc&limit=1&page=2")
      .set(auth(token));

    expect(titles(response)).toEqual(["Datte"]);
    expect(response.body.pagination).toMatchObject({ total: 2, totalPages: 2, page: 2 });
  });

  it("refuse un champ ou un ordre inconnu, y compris une tentative d'injection", async () => {
    const token = await agentWithTickets();

    const unknownField = await request(app).get("/tickets?sortBy=password").set(auth(token));
    const injection = await request(app)
      .get("/tickets")
      .query({ sortBy: 'title"; DROP TABLE "Ticket"; --' })
      .set(auth(token));
    const badOrder = await request(app).get("/tickets?order=sideways").set(auth(token));

    expect(unknownField.status).toBe(400);
    expect(injection.status).toBe(400);
    expect(badOrder.status).toBe(400);
    expect(await prisma.ticket.count()).toBe(4);
  });
});

describe("tri des comptes", () => {
  it("trie par email", async () => {
    const admin = await createUser({ email: "admin@test.local", role: "ADMIN" });
    await createUser({ email: "zoe@test.local", role: "USER" });
    await createUser({ email: "alice@test.local", role: "AGENT" });

    const response = await request(app)
      .get("/users?sortBy=email&order=asc")
      .set(auth(await tokenFor(admin)));

    expect(response.body.data.map((u: { email: string }) => u.email)).toEqual([
      "alice@test.local",
      "zoe@test.local",
    ]);
  });

  it("refuse un champ de tri non autorisé comme passwordHash", async () => {
    const admin = await createUser({ email: "admin@test.local", role: "ADMIN" });

    const response = await request(app)
      .get("/users?sortBy=passwordHash")
      .set(auth(await tokenFor(admin)));

    expect(response.status).toBe(400);
  });
});

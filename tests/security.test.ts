import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import { app } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { createUser, resetDatabase, TEST_PASSWORD, tokenFor } from "./helpers.js";

beforeEach(resetDatabase);

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const sqlPayloads = [
  "' OR '1'='1",
  "'; DROP TABLE \"Ticket\"; --",
  "\" OR 1=1 --",
  "1; SELECT pg_sleep(5); --",
  "') UNION SELECT passwordHash FROM \"User\" --",
  "Robert'); DROP TABLE \"User\";--",
  "\\'; TRUNCATE \"AuditLog\"; --",
];

async function tablesStillIntact() {
  const rows = await prisma.$queryRaw<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`;
  const names = rows.map((row) => row.table_name);

  for (const table of ["User", "Ticket", "AuditLog", "RefreshToken", "OneTimeToken"]) {
    expect(names).toContain(table);
  }
}

describe("injection SQL dans les données enregistrées", () => {
  it.each(sqlPayloads)("stocke %j tel quel, sans jamais l'exécuter", async (payload) => {
    const agent = await createUser({ email: "agent@test.local", role: "AGENT" });
    const token = await tokenFor(agent);

    const created = await request(app)
      .post("/tickets")
      .set(auth(token))
      .send({ title: payload.slice(0, 200), description: payload });
    const fetched = await request(app).get(`/tickets/${created.body.data.id}`).set(auth(token));

    expect(created.status).toBe(201);
    expect(fetched.body.data.title).toBe(payload.slice(0, 200));
    expect(fetched.body.data.description).toBe(payload);
    await tablesStillIntact();
  });
});

describe("injection SQL dans les paramètres de requête", () => {
  it.each(sqlPayloads)("recherche de comptes avec %j : aucun résultat, aucune fuite", async (payload) => {
    const admin = await createUser({ email: "admin@test.local", role: "ADMIN" });
    await createUser({ email: "agent@test.local", role: "AGENT" });
    const token = await tokenFor(admin);

    const response = await request(app).get("/users").query({ search: payload }).set(auth(token));

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([]);
    expect(JSON.stringify(response.body)).not.toContain("passwordHash");
    await tablesStillIntact();
  });

  it.each(sqlPayloads)("filtres et tri de tickets avec %j : refusés par la validation", async (payload) => {
    const agent = await createUser({ email: "agent@test.local", role: "AGENT" });
    const token = await tokenFor(agent);

    const statuses = await Promise.all(
      ["status", "priority", "sortBy", "order", "page", "limit"].map(
        async (param) => (await request(app).get("/tickets").query({ [param]: payload }).set(auth(token))).status,
      ),
    );

    expect(statuses).toEqual([400, 400, 400, 400, 400, 400]);
    await tablesStillIntact();
  });

  it.each(sqlPayloads)("identifiant %j dans l'adresse : refusé avant toute requête SQL", async (payload) => {
    const agent = await createUser({ email: "agent@test.local", role: "AGENT" });
    const token = await tokenFor(agent);

    const responses = await Promise.all([
      request(app).get(`/tickets/${encodeURIComponent(payload)}`).set(auth(token)),
      request(app).patch(`/tickets/${encodeURIComponent(payload)}`).set(auth(token)).send({ title: "x" }),
      request(app).get(`/users/${encodeURIComponent(payload)}`).set(auth(token)),
    ]);

    expect(responses.map((response) => response.status).sort()).not.toContain(500);
    expect(responses[0]!.status).toBe(400);
    await tablesStillIntact();
  });

  it("le caractère % de la recherche est cherché littéralement, pas comme un joker", async () => {
    const admin = await createUser({ email: "admin@test.local", role: "ADMIN" });
    await createUser({ email: "agent@test.local", role: "AGENT" });

    const percent = await request(app).get("/users").query({ search: "%" }).set(auth(await tokenFor(admin)));
    const underscore = await request(app).get("/users").query({ search: "_" }).set(auth(await tokenFor(admin)));

    expect(percent.body.data).toEqual([]);
    expect(underscore.body.data).toEqual([]);
  });
});

describe("injection SQL dans l'authentification", () => {
  it.each(sqlPayloads)("login avec %j : jamais de connexion, jamais d'erreur serveur", async (payload) => {
    await createUser({ email: "agent@test.local", role: "AGENT" });

    const asEmail = await request(app).post("/auth/login").send({ email: payload, password: TEST_PASSWORD });
    const asPassword = await request(app).post("/auth/login").send({ email: "agent@test.local", password: payload });
    const asRefresh = await request(app).post("/auth/refresh").send({ refreshToken: payload });
    const asReset = await request(app).post("/auth/reset-password").send({ token: payload, password: "Motdepasse123" });

    expect(asEmail.status).toBe(400);
    expect(asPassword.status).toBe(401);
    expect(asRefresh.status).toBe(401);
    expect(asReset.status).toBe(400);
    await tablesStillIntact();
  });

  it("un en-tête Authorization piégé est refusé proprement", async () => {
    const responses = await Promise.all(
      sqlPayloads.map((payload) => request(app).get("/tickets").set("Authorization", `Bearer ${payload}`)),
    );

    expect(responses.map((response) => response.status)).toEqual(sqlPayloads.map(() => 401));
  });
});

describe("validation des données entrantes", () => {
  async function agentToken() {
    return tokenFor(await createUser({ email: "agent@test.local", role: "AGENT" }));
  }

  it("refuse les objets, tableaux et opérateurs de type NoSQL à la place d'un texte", async () => {
    const token = await agentToken();

    const bodies = [
      { email: { $ne: null }, password: { $ne: null } },
      { email: ["agent@test.local"], password: TEST_PASSWORD },
      { email: "agent@test.local", password: { contains: "" } },
    ];
    const responses = await Promise.all(bodies.map((body) => request(app).post("/auth/login").send(body)));
    const ticket = await request(app)
      .post("/tickets")
      .set(auth(token))
      .send({ title: { $gt: "" }, description: ["x"] });

    expect(responses.map((response) => response.status)).toEqual([400, 400, 400]);
    expect(ticket.status).toBe(400);
  });

  it("refuse les champs supplémentaires, y compris la pollution de prototype", async () => {
    const token = await agentToken();

    const extra = await request(app)
      .post("/tickets")
      .set(auth(token))
      .send({ title: "T", description: "D", isAdmin: true });
    const proto = await request(app)
      .post("/tickets")
      .set(auth(token))
      .set("Content-Type", "application/json")
      .send('{"title":"T","description":"D","__proto__":{"role":"SUPER_ADMIN"}}');
    const constructor = await request(app)
      .post("/tickets")
      .set(auth(token))
      .send({ title: "T", description: "D", constructor: { prototype: { admin: true } } });

    expect(extra.status).toBe(400);
    expect(proto.status).toBe(400);
    expect(constructor.status).toBe(400);
    expect(({} as Record<string, unknown>).role).toBeUndefined();
  });

  it("refuse l'élévation de privilège par mass assignment sur les comptes", async () => {
    const admin = await createUser({ email: "admin@test.local", role: "ADMIN" });
    const agent = await createUser({ email: "agent@test.local", role: "AGENT" });
    const token = await tokenFor(admin);

    const attempts = [
      { role: "SUPER_ADMIN" },
      { status: "ACTIVE" },
      { passwordHash: "x" },
      { role: "USER", id: "00000000-0000-4000-8000-000000000000" },
    ];
    const responses = await Promise.all(
      attempts.map((body) => request(app).patch(`/users/${agent.id}`).set(auth(token)).send(body)),
    );

    expect(responses.map((response) => response.status)).toEqual([400, 400, 400, 400]);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: agent.id } })).role).toBe("AGENT");
  });

  it("refuse un caractère nul, que PostgreSQL ne sait pas stocker, avec un 400 et non un 500", async () => {
    const token = await agentToken();

    const ticket = await request(app)
      .post("/tickets")
      .set(auth(token))
      .send({ title: "avant\u0000après", description: "D" });
    const search = await request(app).get("/users").query({ search: "a\u0000b" }).set(auth(token));
    const login = await request(app).post("/auth/login").send({ email: "a@b.co\u0000", password: "x\u0000y" });

    expect(ticket.status).toBe(400);
    expect(search.status).not.toBe(500);
    expect(login.status).not.toBe(500);
  });

  it("gère les très longues chaînes et les caractères Unicode sans erreur serveur", async () => {
    const token = await agentToken();
    const emoji = "🎫".repeat(50);

    const unicode = await request(app)
      .post("/tickets")
      .set(auth(token))
      .send({ title: emoji, description: "العربية 日本語 Ελληνικά" });
    const huge = await request(app)
      .post("/tickets")
      .set(auth(token))
      .send({ title: "x".repeat(10_000), description: "D" });

    expect(unicode.status).toBe(201);
    expect(unicode.body.data.title).toBe(emoji);
    expect(huge.status).toBe(400);
  });

  it("refuse un corps qui n'est pas du JSON ou un type de contenu inattendu", async () => {
    const token = await agentToken();

    const text = await request(app)
      .post("/tickets")
      .set(auth(token))
      .set("Content-Type", "text/plain")
      .send("title=T&description=D");
    const form = await request(app)
      .post("/tickets")
      .set(auth(token))
      .type("form")
      .send({ title: "T", description: "D" });

    expect(text.status).toBe(400);
    expect(form.status).toBe(400);
  });
});

describe("en-têtes de sécurité", () => {
  it("n'annonce pas Express et active les protections de helmet", async () => {
    const response = await request(app).get("/health");

    expect(response.headers["x-powered-by"]).toBeUndefined();
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(response.headers["strict-transport-security"]).toBeDefined();
  });
});

describe("jetons forgés", () => {
  it("refuse un jeton signé avec un autre secret, même avec le rôle SUPER_ADMIN", async () => {
    const agent = await createUser({ email: "agent@test.local", role: "AGENT" });
    const { default: jwt } = await import("jsonwebtoken");
    const forged = jwt.sign({ role: "SUPER_ADMIN" }, "un-autre-secret-de-plus-de-32-caracteres!", {
      subject: agent.id,
    });

    const response = await request(app).get("/users").set(auth(forged));

    expect(response.status).toBe(401);
  });

  it("ignore le rôle écrit dans le jeton : c'est celui de la base qui compte", async () => {
    const agent = await createUser({ email: "agent@test.local", role: "AGENT" });
    const { env } = await import("../src/config/env.js");
    const { default: jwt } = await import("jsonwebtoken");
    // Jeton signé avec le vrai secret et lié à une vraie session, mais qui ment sur le rôle.
    const real = await request(app).post("/auth/login").send({ email: agent.email, password: TEST_PASSWORD });
    const { sid } = jwt.decode(real.body.data.accessToken) as { sid: string };
    const lying = jwt.sign({ role: "SUPER_ADMIN", sid }, env.JWT_ACCESS_SECRET, { subject: agent.id });

    const users = await request(app).get("/users").set(auth(lying));
    const audit = await request(app).get("/audit-logs").set(auth(lying));

    expect(users.status).toBe(403);
    expect(audit.status).toBe(403);
  });
});

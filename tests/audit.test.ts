import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { app } from "../src/app.js";
import { env } from "../src/config/env.js";
import { prisma } from "../src/lib/prisma.js";
import { captureEmails, createUser, extractToken, resetDatabase, TEST_PASSWORD, tokenFor } from "./helpers.js";

beforeEach(resetDatabase);
afterEach(() => vi.restoreAllMocks());

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function logsFor(action: string) {
  return prisma.auditLog.findMany({ where: { action }, orderBy: { createdAt: "asc" } });
}

async function setup() {
  await captureEmails();
  const superAdmin = await createUser({ email: "root@test.local", role: "SUPER_ADMIN" });
  const agent = await createUser({ email: "agent@test.local", role: "AGENT" });

  return { superAdmin, agent, superToken: await tokenFor(superAdmin), agentToken: await tokenFor(agent) };
}

describe("journal des comptes", () => {
  it("enregistre une invitation avec l'acteur, la cible et l'adresse IP", async () => {
    const { superAdmin, superToken } = await setup();

    const created = await request(app)
      .post("/users")
      .set(auth(superToken))
      .send({ email: "nouveau@test.local", role: "USER" });

    const [log] = await logsFor("USER_INVITED");
    expect(log).toMatchObject({
      actorId: superAdmin.id,
      actorEmail: "root@test.local",
      targetType: "User",
      targetId: created.body.data.id,
      metadata: { email: "nouveau@test.local", role: "USER", emailSent: true },
    });
    expect(log!.ip).toEqual(expect.any(String));
  });

  it("enregistre un changement de rôle avec l'ancienne et la nouvelle valeur", async () => {
    const { superToken, agent } = await setup();

    await request(app).patch(`/users/${agent.id}`).set(auth(superToken)).send({ role: "ADMIN" });

    const [log] = await logsFor("USER_ROLE_CHANGED");
    expect(log!.metadata).toEqual({ role: { from: "AGENT", to: "ADMIN" } });
    expect(await logsFor("USER_UPDATED")).toHaveLength(0);
  });

  it("enregistre un changement d'email à part, et rien si rien n'a changé", async () => {
    const { superToken, agent } = await setup();

    await request(app).patch(`/users/${agent.id}`).set(auth(superToken)).send({ email: "autre@test.local" });
    await request(app).patch(`/users/${agent.id}`).set(auth(superToken)).send({ email: "autre@test.local" });

    const updates = await logsFor("USER_UPDATED");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.metadata).toEqual({ email: { from: "agent@test.local", to: "autre@test.local" } });
    expect(await logsFor("USER_ROLE_CHANGED")).toHaveLength(0);
  });

  it("enregistre la désactivation et la réactivation", async () => {
    const { superToken, agent } = await setup();

    await request(app).post(`/users/${agent.id}/disable`).set(auth(superToken));
    await request(app).post(`/users/${agent.id}/enable`).set(auth(superToken));

    expect((await logsFor("USER_DISABLED"))[0]).toMatchObject({ targetId: agent.id, actorEmail: "root@test.local" });
    expect((await logsFor("USER_ENABLED"))[0]!.metadata).toMatchObject({ previousStatus: "DISABLED", status: "ACTIVE" });
  });

  it("garde la trace d'un compte supprimé, avec son email et son rôle", async () => {
    const { superToken, agent } = await setup();

    await request(app).delete(`/users/${agent.id}`).set(auth(superToken));

    const [log] = await logsFor("USER_DELETED");
    expect(log).toMatchObject({ targetId: agent.id, metadata: { email: "agent@test.local", role: "AGENT" } });
    expect(await prisma.user.findUnique({ where: { id: agent.id } })).toBeNull();
  });

  it("n'écrit rien quand l'action est refusée", async () => {
    const { agentToken, superAdmin } = await setup();

    const response = await request(app).post(`/users/${superAdmin.id}/disable`).set(auth(agentToken));

    expect(response.status).toBe(403);
    expect(await logsFor("USER_DISABLED")).toHaveLength(0);
  });
});

describe("journal de l'authentification", () => {
  it("enregistre les connexions réussies et les échecs, sans jamais le mot de passe", async () => {
    await setup();

    await request(app).post("/auth/login").send({ email: "agent@test.local", password: "MotDePasseSecret999" });
    await request(app).post("/auth/login").send({ email: "inconnu@test.local", password: "AutreSecret777" });

    const failures = await logsFor("LOGIN_FAILED");
    expect(failures.map((log) => log.actorEmail)).toEqual(["agent@test.local", "inconnu@test.local"]);
    expect(failures[0]!.targetId).toEqual(expect.any(String));
    expect(failures[1]!.targetId).toBeNull();
    expect((await logsFor("LOGIN_SUCCESS")).length).toBeGreaterThanOrEqual(2);

    const everything = JSON.stringify(await prisma.auditLog.findMany());
    expect(everything).not.toContain("MotDePasseSecret999");
    expect(everything).not.toContain("AutreSecret777");
    expect(everything).not.toContain(TEST_PASSWORD);
  });

  it("enregistre le verrouillage d'un compte", async () => {
    const { agent } = await setup();

    for (let i = 0; i < env.LOGIN_MAX_ATTEMPTS; i++) {
      await request(app).post("/auth/login").send({ email: "agent@test.local", password: "Mauvais123456" });
    }

    const [log] = await logsFor("ACCOUNT_LOCKED");
    expect(log).toMatchObject({ targetId: agent.id, metadata: { lockMinutes: env.LOGIN_LOCK_MINUTES } });
  });

  it("enregistre l'acceptation d'invitation, la demande et la fin de réinitialisation, sans les jetons", async () => {
    const emails = await captureEmails();
    const admin = await createUser({ email: "admin@test.local", role: "ADMIN" });
    await request(app)
      .post("/users")
      .set(auth(await tokenFor(admin)))
      .send({ email: "nouveau@test.local", role: "USER" });
    const inviteToken = extractToken(emails[0]);

    await request(app).post("/auth/accept-invite").send({ token: inviteToken, password: "NouveauMdp2026" });
    await request(app).post("/auth/forgot-password").send({ email: "nouveau@test.local" });
    const resetToken = extractToken(emails[1]);
    await request(app).post("/auth/reset-password").send({ token: resetToken, password: "EncoreUnAutre2026" });

    expect(await logsFor("INVITE_ACCEPTED")).toHaveLength(1);
    expect(await logsFor("PASSWORD_RESET_REQUESTED")).toHaveLength(1);
    expect(await logsFor("PASSWORD_RESET_COMPLETED")).toHaveLength(1);

    const everything = JSON.stringify(await prisma.auditLog.findMany());
    for (const secret of [inviteToken, resetToken, "NouveauMdp2026", "EncoreUnAutre2026"]) {
      expect(everything).not.toContain(secret);
    }
  });

  it("n'enregistre pas de demande de réinitialisation pour un email inconnu", async () => {
    await setup();

    await request(app).post("/auth/forgot-password").send({ email: "inconnu@test.local" });

    expect(await logsFor("PASSWORD_RESET_REQUESTED")).toHaveLength(0);
  });
});

describe("journal des tickets", () => {
  const body = { title: "Imprimante en panne", description: "Contenu confidentiel du ticket", priority: "HIGH" };

  it("enregistre création, modification, remplacement et suppression", async () => {
    const { agentToken, superToken } = await setup();

    const created = await request(app).post("/tickets").set(auth(agentToken)).send(body);
    const id = created.body.data.id as string;
    await request(app).patch(`/tickets/${id}`).set(auth(agentToken)).send({ status: "IN_PROGRESS" });
    await request(app)
      .put(`/tickets/${id}`)
      .set(auth(agentToken))
      .send({ title: "Nouveau titre", description: "d", status: "CLOSED", priority: "LOW" });
    await request(app).delete(`/tickets/${id}`).set(auth(superToken));

    expect((await logsFor("TICKET_CREATED"))[0]).toMatchObject({ targetType: "Ticket", targetId: id });
    expect((await logsFor("TICKET_UPDATED"))[0]!.metadata).toEqual({ status: { from: "OPEN", to: "IN_PROGRESS" } });
    expect((await logsFor("TICKET_REPLACED"))[0]!.metadata).toEqual({
      status: { from: "IN_PROGRESS", to: "CLOSED" },
      priority: { from: "HIGH", to: "LOW" },
      editedFields: ["title", "description"],
    });
    expect((await logsFor("TICKET_DELETED"))[0]).toMatchObject({
      targetId: id,
      actorEmail: "root@test.local",
      metadata: { title: "Nouveau titre" },
    });
  });

  it("ne copie jamais la description d'un ticket dans le journal", async () => {
    const { agentToken } = await setup();

    const created = await request(app).post("/tickets").set(auth(agentToken)).send(body);
    await request(app)
      .patch(`/tickets/${created.body.data.id}`)
      .set(auth(agentToken))
      .send({ description: "Autre contenu confidentiel" });

    const everything = JSON.stringify(await prisma.auditLog.findMany());
    expect(everything).not.toContain("confidentiel");
    expect((await logsFor("TICKET_UPDATED"))[0]!.metadata).toEqual({ editedFields: ["description"] });
  });

  it("une modification refusée à un USER n'est pas journalisée", async () => {
    await setup();
    const user = await createUser({ email: "user@test.local", role: "USER" });
    const userToken = await tokenFor(user);
    const created = await request(app).post("/tickets").set(auth(userToken)).send(body);

    const refused = await request(app)
      .patch(`/tickets/${created.body.data.id}`)
      .set(auth(userToken))
      .send({ status: "CLOSED" });

    expect(refused.status).toBe(403);
    expect(await logsFor("TICKET_UPDATED")).toHaveLength(0);
  });
});

describe("robustesse", () => {
  it("une panne d'écriture du journal ne fait pas échouer l'action", async () => {
    const { superToken } = await setup();
    vi.spyOn(prisma.auditLog, "create").mockRejectedValue(new Error("base du journal indisponible"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await request(app)
      .post("/users")
      .set(auth(superToken))
      .send({ email: "nouveau@test.local", role: "USER" });

    expect(response.status).toBe(201);
    expect(log).toHaveBeenCalled();
  });
});

describe("GET /audit-logs", () => {
  it("est réservé au Super Admin", async () => {
    const { superToken, agentToken } = await setup();
    const admin = await createUser({ email: "admin@test.local", role: "ADMIN" });

    const asSuper = await request(app).get("/audit-logs").set(auth(superToken));
    const asAdmin = await request(app).get("/audit-logs").set(auth(await tokenFor(admin)));
    const asAgent = await request(app).get("/audit-logs").set(auth(agentToken));
    const anonymous = await request(app).get("/audit-logs");

    expect(asSuper.status).toBe(200);
    expect(asAdmin.status).toBe(403);
    expect(asAgent.status).toBe(403);
    expect(anonymous.status).toBe(401);
  });

  it("filtre par action, par cible et par acteur, avec pagination", async () => {
    const { superToken, agent, superAdmin } = await setup();
    await request(app).post(`/users/${agent.id}/disable`).set(auth(superToken));
    await request(app).post(`/users/${agent.id}/enable`).set(auth(superToken));

    const byAction = await request(app).get("/audit-logs?action=USER_DISABLED").set(auth(superToken));
    const byTarget = await request(app)
      .get(`/audit-logs?targetType=User&targetId=${agent.id}&order=asc&limit=1`)
      .set(auth(superToken));
    const byActor = await request(app).get(`/audit-logs?actorId=${superAdmin.id}`).set(auth(superToken));

    expect(byAction.body.data).toHaveLength(1);
    expect(byAction.body.data[0].action).toBe("USER_DISABLED");
    expect(byTarget.body.data).toHaveLength(1);
    expect(byTarget.body.pagination.total).toBeGreaterThanOrEqual(2);
    expect(byActor.body.data.every((log: { actorId: string }) => log.actorId === superAdmin.id)).toBe(true);
  });

  it("filtre par période", async () => {
    const { superToken } = await setup();
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const none = await request(app).get("/audit-logs").query({ from: future }).set(auth(superToken));
    const all = await request(app)
      .get("/audit-logs")
      .query({ to: future, limit: 100 })
      .set(auth(superToken));

    expect(none.body.data).toHaveLength(0);
    expect(all.body.data.length).toBeGreaterThan(0);
  });

  it("refuse une action inconnue, un identifiant invalide ou une date invalide", async () => {
    const { superToken } = await setup();

    const action = await request(app).get("/audit-logs?action=PIRATAGE").set(auth(superToken));
    const actor = await request(app).get("/audit-logs?actorId=pas-un-uuid").set(auth(superToken));
    const date = await request(app).get("/audit-logs?from=hier").set(auth(superToken));
    const injection = await request(app)
      .get("/audit-logs")
      .query({ action: "'; DROP TABLE \"AuditLog\"; --" })
      .set(auth(superToken));

    expect(action.status).toBe(400);
    expect(actor.status).toBe(400);
    expect(date.status).toBe(400);
    expect(injection.status).toBe(400);
    expect(await prisma.auditLog.count()).toBeGreaterThan(0);
  });
});

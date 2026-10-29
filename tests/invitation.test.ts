import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import { app } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { captureEmails, createUser, extractToken, resetDatabase, tokenFor } from "./helpers.js";

beforeEach(resetDatabase);

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const NEW_PASSWORD = "NouveauMdp2026";

describe("POST /users (invitation)", () => {
  it("crée un compte INVITED et envoie un email avec un lien à usage unique", async () => {
    const emails = await captureEmails();
    const superAdmin = await createUser({ email: "root@test.local", role: "SUPER_ADMIN" });
    const token = await tokenFor(superAdmin);

    const response = await request(app)
      .post("/users")
      .set(auth(token))
      .send({ email: " Nouveau@Test.local ", role: "AGENT" });

    expect(response.status).toBe(201);
    expect(response.body.emailSent).toBe(true);
    expect(response.body.data).toMatchObject({
      email: "nouveau@test.local",
      role: "AGENT",
      status: "INVITED",
      createdById: superAdmin.id,
    });
    expect(emails).toHaveLength(1);
    expect(emails[0]!.to).toBe("nouveau@test.local");
    expect(emails[0]!.text).toContain("/auth/accept-invite?token=");

    const stored = await prisma.oneTimeToken.findMany();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.tokenHash).not.toBe(extractToken(emails[0]));
  });

  it("respecte la hiérarchie : un Admin ne peut inviter qu'AGENT et USER", async () => {
    await captureEmails();
    const admin = await createUser({ email: "admin@test.local", role: "ADMIN" });
    const token = await tokenFor(admin);

    const asAdmin = await request(app).post("/users").set(auth(token)).send({ email: "a@test.local", role: "ADMIN" });
    const asAgent = await request(app).post("/users").set(auth(token)).send({ email: "b@test.local", role: "AGENT" });
    const superRole = await request(app)
      .post("/users")
      .set(auth(token))
      .send({ email: "c@test.local", role: "SUPER_ADMIN" });

    expect(asAdmin.status).toBe(403);
    expect(asAgent.status).toBe(201);
    expect(superRole.status).toBe(400);
  });

  it("refuse les rôles AGENT et USER, un email déjà pris et un corps invalide", async () => {
    await captureEmails();
    const agent = await createUser({ email: "agent@test.local", role: "AGENT" });
    const admin = await createUser({ email: "admin@test.local", role: "ADMIN" });

    const forbidden = await request(app)
      .post("/users")
      .set(auth(await tokenFor(agent)))
      .send({ email: "x@test.local", role: "USER" });
    const adminToken = await tokenFor(admin);
    const duplicate = await request(app)
      .post("/users")
      .set(auth(adminToken))
      .send({ email: "agent@test.local", role: "USER" });
    const invalid = await request(app).post("/users").set(auth(adminToken)).send({ email: "pas-un-email" });

    expect(forbidden.status).toBe(403);
    expect(duplicate.status).toBe(409);
    expect(invalid.status).toBe(400);
  });

  it("crée quand même le compte si l'email échoue, et signale emailSent=false", async () => {
    await captureEmails({ failing: true });
    const admin = await createUser({ email: "admin@test.local", role: "ADMIN" });

    const response = await request(app)
      .post("/users")
      .set(auth(await tokenFor(admin)))
      .send({ email: "nouveau@test.local", role: "USER" });

    expect(response.status).toBe(201);
    expect(response.body.emailSent).toBe(false);
    expect(await prisma.user.count({ where: { email: "nouveau@test.local" } })).toBe(1);
  });
});

describe("POST /auth/accept-invite", () => {
  async function invite() {
    const emails = await captureEmails();
    const admin = await createUser({ email: "admin@test.local", role: "ADMIN" });
    await request(app)
      .post("/users")
      .set(auth(await tokenFor(admin)))
      .send({ email: "nouveau@test.local", role: "USER" });

    return { emails, token: extractToken(emails[0]) };
  }

  it("active le compte, définit le mot de passe et permet de se connecter", async () => {
    const { token } = await invite();

    const accepted = await request(app).post("/auth/accept-invite").send({ token, password: NEW_PASSWORD });
    const login = await request(app)
      .post("/auth/login")
      .send({ email: "nouveau@test.local", password: NEW_PASSWORD });

    expect(accepted.status).toBe(200);
    expect(accepted.body.data).toMatchObject({ email: "nouveau@test.local", status: "ACTIVE" });
    expect(login.status).toBe(200);
  });

  it("ne fonctionne qu'une seule fois", async () => {
    const { token } = await invite();

    const first = await request(app).post("/auth/accept-invite").send({ token, password: NEW_PASSWORD });
    const second = await request(app).post("/auth/accept-invite").send({ token, password: "AutreMdp2026xx" });

    expect(first.status).toBe(200);
    expect(second.status).toBe(400);
  });

  it("refuse un jeton inconnu, expiré ou un mot de passe trop faible", async () => {
    const { token } = await invite();

    const weak = await request(app).post("/auth/accept-invite").send({ token, password: "court1" });
    const unknown = await request(app).post("/auth/accept-invite").send({ token: "inconnu", password: NEW_PASSWORD });
    await prisma.oneTimeToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await request(app).post("/auth/accept-invite").send({ token, password: NEW_PASSWORD });

    expect(weak.status).toBe(400);
    expect(unknown.status).toBe(400);
    expect(expired.status).toBe(400);
  });
});

describe("POST /users/:id/resend-invite", () => {
  it("renvoie une invitation et invalide la précédente", async () => {
    const emails = await captureEmails();
    const admin = await createUser({ email: "admin@test.local", role: "ADMIN" });
    const adminToken = await tokenFor(admin);
    const created = await request(app)
      .post("/users")
      .set(auth(adminToken))
      .send({ email: "nouveau@test.local", role: "USER" });
    const firstToken = extractToken(emails[0]);

    const resent = await request(app).post(`/users/${created.body.data.id}/resend-invite`).set(auth(adminToken));
    const secondToken = extractToken(emails[1]);
    const oldLink = await request(app).post("/auth/accept-invite").send({ token: firstToken, password: NEW_PASSWORD });
    const newLink = await request(app)
      .post("/auth/accept-invite")
      .send({ token: secondToken, password: NEW_PASSWORD });

    expect(resent.status).toBe(200);
    expect(emails).toHaveLength(2);
    expect(oldLink.status).toBe(400);
    expect(newLink.status).toBe(200);
  });

  it("refuse si le compte est déjà activé (409)", async () => {
    await captureEmails();
    const admin = await createUser({ email: "admin@test.local", role: "ADMIN" });
    const active = await createUser({ email: "actif@test.local", role: "USER" });

    const response = await request(app)
      .post(`/users/${active.id}/resend-invite`)
      .set(auth(await tokenFor(admin)));

    expect(response.status).toBe(409);
  });
});

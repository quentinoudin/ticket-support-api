import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import { app } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { captureEmails, createUser, extractToken, resetDatabase, TEST_PASSWORD } from "./helpers.js";

beforeEach(resetDatabase);

const NEW_PASSWORD = "NouveauMdp2026";

describe("POST /auth/forgot-password", () => {
  it("envoie un lien à un compte actif", async () => {
    const emails = await captureEmails();
    await createUser({ email: "agent@test.local", role: "AGENT" });

    const response = await request(app).post("/auth/forgot-password").send({ email: " AGENT@test.local" });

    expect(response.status).toBe(200);
    expect(emails).toHaveLength(1);
    expect(emails[0]!.to).toBe("agent@test.local");
    expect(emails[0]!.text).toContain("/auth/reset-password?token=");
  });

  it("répond exactement pareil pour un email inconnu, invité ou désactivé, sans rien envoyer", async () => {
    const emails = await captureEmails();
    await createUser({ email: "agent@test.local", role: "AGENT" });
    await createUser({ email: "invite@test.local", status: "INVITED", password: null });
    await createUser({ email: "off@test.local", status: "DISABLED" });

    const known = await request(app).post("/auth/forgot-password").send({ email: "agent@test.local" });
    const unknown = await request(app).post("/auth/forgot-password").send({ email: "inconnu@test.local" });
    const invited = await request(app).post("/auth/forgot-password").send({ email: "invite@test.local" });
    const disabled = await request(app).post("/auth/forgot-password").send({ email: "off@test.local" });

    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
    expect(invited.body).toEqual(known.body);
    expect(disabled.body).toEqual(known.body);
    expect(emails).toHaveLength(1);
  });

  it("répond 200 même si l'envoi de l'email échoue", async () => {
    await captureEmails({ failing: true });
    await createUser({ email: "agent@test.local", role: "AGENT" });

    const response = await request(app).post("/auth/forgot-password").send({ email: "agent@test.local" });

    expect(response.status).toBe(200);
  });

  it("renvoie 400 pour un email invalide", async () => {
    const response = await request(app).post("/auth/forgot-password").send({ email: "nope" });

    expect(response.status).toBe(400);
  });
});

describe("POST /auth/reset-password", () => {
  async function requestReset() {
    const emails = await captureEmails();
    const user = await createUser({ email: "agent@test.local", role: "AGENT" });
    await request(app).post("/auth/forgot-password").send({ email: user.email });

    return { user, emails, token: extractToken(emails[0]) };
  }

  it("change le mot de passe, une seule fois", async () => {
    const { token } = await requestReset();

    const reset = await request(app).post("/auth/reset-password").send({ token, password: NEW_PASSWORD });
    const replay = await request(app).post("/auth/reset-password").send({ token, password: "AutreMdp2026xx" });
    const oldPassword = await request(app)
      .post("/auth/login")
      .send({ email: "agent@test.local", password: TEST_PASSWORD });
    const newPassword = await request(app)
      .post("/auth/login")
      .send({ email: "agent@test.local", password: NEW_PASSWORD });

    expect(reset.status).toBe(204);
    expect(replay.status).toBe(400);
    expect(oldPassword.status).toBe(401);
    expect(newPassword.status).toBe(200);
  });

  it("révoque toutes les sessions ouvertes", async () => {
    const { token } = await requestReset();
    const login = await request(app)
      .post("/auth/login")
      .send({ email: "agent@test.local", password: TEST_PASSWORD });

    await request(app).post("/auth/reset-password").send({ token, password: NEW_PASSWORD });
    const refresh = await request(app).post("/auth/refresh").send({ refreshToken: login.body.data.refreshToken });

    expect(refresh.status).toBe(401);
  });

  it("un nouveau lien invalide le précédent", async () => {
    const { emails, token: firstToken } = await requestReset();
    await request(app).post("/auth/forgot-password").send({ email: "agent@test.local" });
    const secondToken = extractToken(emails[1]);

    const oldLink = await request(app).post("/auth/reset-password").send({ token: firstToken, password: NEW_PASSWORD });
    const newLink = await request(app)
      .post("/auth/reset-password")
      .send({ token: secondToken, password: NEW_PASSWORD });

    expect(oldLink.status).toBe(400);
    expect(newLink.status).toBe(204);
  });

  it("refuse un jeton inconnu, expiré, un mot de passe faible, ou un compte désactivé entre-temps", async () => {
    const { user, token } = await requestReset();

    const weak = await request(app).post("/auth/reset-password").send({ token, password: "court" });
    const unknown = await request(app).post("/auth/reset-password").send({ token: "inconnu", password: NEW_PASSWORD });
    await prisma.user.update({ where: { id: user.id }, data: { status: "DISABLED" } });
    const disabled = await request(app).post("/auth/reset-password").send({ token, password: NEW_PASSWORD });

    expect(weak.status).toBe(400);
    expect(unknown.status).toBe(400);
    expect(disabled.status).toBe(400);
  });

  it("refuse un lien expiré", async () => {
    const { token } = await requestReset();
    await prisma.oneTimeToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    const response = await request(app).post("/auth/reset-password").send({ token, password: NEW_PASSWORD });

    expect(response.status).toBe(400);
  });
});

import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import { app } from "../src/app.js";
import { createUser, resetDatabase, TEST_PASSWORD } from "./helpers.js";

beforeEach(resetDatabase);

describe("POST /auth/login", () => {
  it("renvoie un access token pour des identifiants valides", async () => {
    const user = await createUser({ email: "agent@test.local", role: "AGENT" });

    const response = await request(app)
      .post("/auth/login")
      .send({ email: "  AGENT@test.local ", password: TEST_PASSWORD });

    expect(response.status).toBe(200);
    expect(response.body.data.accessToken).toEqual(expect.any(String));
    expect(response.body.data.user).toEqual({
      id: user.id,
      email: "agent@test.local",
      role: "AGENT",
      status: "ACTIVE",
    });
    expect(JSON.stringify(response.body)).not.toContain("passwordHash");
  });

  it("refuse un mauvais mot de passe et un email inconnu avec le même message", async () => {
    await createUser({ email: "agent@test.local" });

    const wrongPassword = await request(app)
      .post("/auth/login")
      .send({ email: "agent@test.local", password: "Mauvais123456" });
    const unknownEmail = await request(app)
      .post("/auth/login")
      .send({ email: "inconnu@test.local", password: TEST_PASSWORD });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body).toEqual(unknownEmail.body);
  });

  it("refuse un compte invité qui n'a pas encore de mot de passe", async () => {
    await createUser({ email: "invite@test.local", status: "INVITED", password: null });

    const response = await request(app)
      .post("/auth/login")
      .send({ email: "invite@test.local", password: TEST_PASSWORD });

    expect(response.status).toBe(401);
  });

  it("refuse un compte désactivé avec 403", async () => {
    await createUser({ email: "off@test.local", status: "DISABLED" });

    const response = await request(app)
      .post("/auth/login")
      .send({ email: "off@test.local", password: TEST_PASSWORD });

    expect(response.status).toBe(403);
  });

  it("renvoie 400 si le corps est invalide", async () => {
    const response = await request(app).post("/auth/login").send({ email: "pas-un-email" });

    expect(response.status).toBe(400);
  });
});

describe("GET /auth/me", () => {
  async function loginAs(email: string) {
    const response = await request(app).post("/auth/login").send({ email, password: TEST_PASSWORD });
    return response.body.data.accessToken as string;
  }

  it("renvoie le profil de l'utilisateur connecté", async () => {
    await createUser({ email: "admin@test.local", role: "ADMIN" });
    const token = await loginAs("admin@test.local");

    const response = await request(app).get("/auth/me").set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ email: "admin@test.local", role: "ADMIN" });
  });

  it("refuse sans jeton ou avec un jeton invalide", async () => {
    const missing = await request(app).get("/auth/me");
    const invalid = await request(app).get("/auth/me").set("Authorization", "Bearer n-importe-quoi");

    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
  });

  it("coupe l'accès dès que le compte est désactivé", async () => {
    const user = await createUser({ email: "agent@test.local", role: "AGENT" });
    const token = await loginAs("agent@test.local");

    const { prisma } = await import("../src/lib/prisma.js");
    await prisma.user.update({ where: { id: user.id }, data: { status: "DISABLED" } });

    const response = await request(app).get("/auth/me").set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(401);
  });
});

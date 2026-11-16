import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import { app } from "../src/app.js";
import { env } from "../src/config/env.js";
import { errorHandler } from "../src/middlewares/error-handler.js";
import { createLimiter } from "../src/middlewares/rate-limit.js";
import { prisma } from "../src/lib/prisma.js";
import { captureEmails, createUser, extractToken, resetDatabase, TEST_PASSWORD } from "./helpers.js";

beforeEach(resetDatabase);

describe("limiteur de requêtes", () => {
  function appWithLimit(limit: number) {
    const testApp = express();
    testApp.use(createLimiter({ windowMs: 60_000, limit, message: "Stop", skip: () => false }));
    testApp.get("/ping", (_request, response) => {
      response.json({ ok: true });
    });
    testApp.use(errorHandler);
    return testApp;
  }

  it("laisse passer jusqu'à la limite puis répond 429 au format standard", async () => {
    const testApp = appWithLimit(3);

    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      statuses.push((await request(testApp).get("/ping")).status);
    }
    const blocked = await request(testApp).get("/ping");

    expect(statuses).toEqual([200, 200, 200]);
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: "Stop", code: "RATE_LIMITED" });
  });

  it("indique à l'appelant quand réessayer", async () => {
    const testApp = appWithLimit(1);
    await request(testApp).get("/ping");

    const blocked = await request(testApp).get("/ping");

    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
  });
});

describe("verrouillage du compte après des échecs de connexion", () => {
  const wrong = { email: "agent@test.local", password: "Mauvais123456" };

  async function failTimes(count: number) {
    for (let i = 0; i < count; i++) {
      await request(app).post("/auth/login").send(wrong);
    }
  }

  it("verrouille le compte après LOGIN_MAX_ATTEMPTS échecs, même avec le bon mot de passe", async () => {
    await createUser({ email: "agent@test.local", role: "AGENT" });

    await failTimes(env.LOGIN_MAX_ATTEMPTS);
    const locked = await request(app)
      .post("/auth/login")
      .send({ email: "agent@test.local", password: TEST_PASSWORD });

    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe("RATE_LIMITED");
  });

  it("ne verrouille pas avant la limite et remet le compteur à zéro après un succès", async () => {
    await createUser({ email: "agent@test.local", role: "AGENT" });

    await failTimes(env.LOGIN_MAX_ATTEMPTS - 1);
    const success = await request(app)
      .post("/auth/login")
      .send({ email: "agent@test.local", password: TEST_PASSWORD });
    await failTimes(env.LOGIN_MAX_ATTEMPTS - 1);
    const stillOk = await request(app)
      .post("/auth/login")
      .send({ email: "agent@test.local", password: TEST_PASSWORD });

    expect(success.status).toBe(200);
    expect(stillOk.status).toBe(200);
  });

  it("se déverrouille à l'expiration du délai", async () => {
    const user = await createUser({ email: "agent@test.local", role: "AGENT" });
    await failTimes(env.LOGIN_MAX_ATTEMPTS);
    await prisma.user.update({ where: { id: user.id }, data: { lockedUntil: new Date(Date.now() - 1000) } });

    const response = await request(app)
      .post("/auth/login")
      .send({ email: "agent@test.local", password: TEST_PASSWORD });

    expect(response.status).toBe(200);
  });

  it("n'a aucun effet sur un email inconnu, qui répond toujours 401", async () => {
    const results = [];
    for (let i = 0; i < env.LOGIN_MAX_ATTEMPTS + 2; i++) {
      results.push((await request(app).post("/auth/login").send({ email: "inconnu@test.local", password: "x" })).status);
    }

    expect(new Set(results)).toEqual(new Set([401]));
  });

  it("une réinitialisation de mot de passe lève le verrouillage", async () => {
    const emails = await captureEmails();
    await createUser({ email: "agent@test.local", role: "AGENT" });
    await failTimes(env.LOGIN_MAX_ATTEMPTS);
    await request(app).post("/auth/forgot-password").send({ email: "agent@test.local" });

    await request(app)
      .post("/auth/reset-password")
      .send({ token: extractToken(emails[0]), password: "NouveauMdp2026" });
    const login = await request(app)
      .post("/auth/login")
      .send({ email: "agent@test.local", password: "NouveauMdp2026" });

    expect(login.status).toBe(200);
  });
});

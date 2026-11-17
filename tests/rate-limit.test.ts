import express from "express";
import { settleBackgroundWork } from "../src/services/auth.service.js";
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

describe("blocage des échecs de connexion par (email, adresse IP)", () => {
  const wrong = { email: "agent@test.local", password: "Mauvais123456" };

  async function failTimes(count: number, ip?: string, body: object = wrong) {
    for (let i = 0; i < count; i++) {
      const call = request(app).post("/auth/login");
      await (ip ? call.set("X-Forwarded-For", ip) : call).send(body);
    }
  }

  async function withProxy<T>(run: () => Promise<T>): Promise<T> {
    app.set("trust proxy", 1);
    try {
      return await run();
    } finally {
      app.set("trust proxy", 0);
    }
  }

  it("bloque après LOGIN_MAX_ATTEMPTS échecs depuis la même adresse, même avec le bon mot de passe", async () => {
    await createUser({ email: "agent@test.local", role: "AGENT" });

    await failTimes(env.LOGIN_MAX_ATTEMPTS);
    const locked = await request(app).post("/auth/login").send({ email: "agent@test.local", password: TEST_PASSWORD });

    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe("RATE_LIMITED");
  });

  it("ne bloque PAS le propriétaire qui se connecte depuis une autre adresse (VULN-003)", async () => {
    await createUser({ email: "agent@test.local", role: "AGENT" });

    await withProxy(async () => {
      await failTimes(env.LOGIN_MAX_ATTEMPTS, "203.0.113.5");
      const owner = await request(app)
        .post("/auth/login")
        .set("X-Forwarded-For", "198.51.100.7")
        .send({ email: "agent@test.local", password: TEST_PASSWORD });

      expect(owner.status).toBe(200);
    });
  });

  it("répond de la même façon pour un compte existant et pour un email inconnu (VULN-004)", async () => {
    await createUser({ email: "agent@test.local", role: "AGENT" });
    const known: number[] = [];
    const unknown: number[] = [];

    for (let i = 0; i < env.LOGIN_MAX_ATTEMPTS + 2; i++) {
      known.push((await request(app).post("/auth/login").send(wrong)).status);
      unknown.push((await request(app).post("/auth/login").send({ ...wrong, email: "inconnu@test.local" })).status);
    }

    expect(unknown).toEqual(known);
    expect(known.at(-1)).toBe(429);
  });

  it("ne bloque pas avant la limite et remet le compteur à zéro après un succès", async () => {
    await createUser({ email: "agent@test.local", role: "AGENT" });

    await failTimes(env.LOGIN_MAX_ATTEMPTS - 1);
    const success = await request(app).post("/auth/login").send({ email: "agent@test.local", password: TEST_PASSWORD });
    await failTimes(env.LOGIN_MAX_ATTEMPTS - 1);
    const stillOk = await request(app).post("/auth/login").send({ email: "agent@test.local", password: TEST_PASSWORD });

    expect(success.status).toBe(200);
    expect(stillOk.status).toBe(200);
  });

  it("une réinitialisation de mot de passe lève le blocage", async () => {
    const emails = await captureEmails();
    await createUser({ email: "agent@test.local", role: "AGENT" });
    await failTimes(env.LOGIN_MAX_ATTEMPTS);
    await request(app).post("/auth/forgot-password").send({ email: "agent@test.local" });
    await settleBackgroundWork();

    await request(app).post("/auth/reset-password").send({ token: extractToken(emails[0]), password: "NouveauMdp2026" });
    const login = await request(app).post("/auth/login").send({ email: "agent@test.local", password: "NouveauMdp2026" });

    expect(login.status).toBe(200);
  });
});

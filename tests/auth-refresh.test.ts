import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import { app } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { createUser, resetDatabase, TEST_PASSWORD } from "./helpers.js";

beforeEach(resetDatabase);

async function login(email = "agent@test.local") {
  const response = await request(app).post("/auth/login").send({ email, password: TEST_PASSWORD });
  return response.body.data as { accessToken: string; refreshToken: string };
}

describe("POST /auth/refresh", () => {
  it("renvoie un nouveau couple de jetons et fait tourner le refresh token", async () => {
    await createUser({ email: "agent@test.local", role: "AGENT" });
    const first = await login();

    const response = await request(app).post("/auth/refresh").send({ refreshToken: first.refreshToken });

    expect(response.status).toBe(200);
    expect(response.body.data.refreshToken).not.toBe(first.refreshToken);

    const me = await request(app)
      .get("/auth/me")
      .set("Authorization", `Bearer ${response.body.data.accessToken}`);
    expect(me.status).toBe(200);
  });

  it("révoque toute la chaîne si un ancien refresh token est rejoué", async () => {
    await createUser({ email: "agent@test.local", role: "AGENT" });
    const first = await login();
    const second = await request(app).post("/auth/refresh").send({ refreshToken: first.refreshToken });

    const replay = await request(app).post("/auth/refresh").send({ refreshToken: first.refreshToken });
    const afterReplay = await request(app)
      .post("/auth/refresh")
      .send({ refreshToken: second.body.data.refreshToken });

    expect(replay.status).toBe(401);
    expect(afterReplay.status).toBe(401);
  });

  it("refuse un jeton inconnu ou expiré", async () => {
    await createUser({ email: "agent@test.local", role: "AGENT" });
    const first = await login();
    await prisma.refreshToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    const unknown = await request(app).post("/auth/refresh").send({ refreshToken: "inconnu" });
    const expired = await request(app).post("/auth/refresh").send({ refreshToken: first.refreshToken });

    expect(unknown.status).toBe(401);
    expect(expired.status).toBe(401);
  });

  it("refuse le refresh d'un compte désactivé", async () => {
    const user = await createUser({ email: "agent@test.local", role: "AGENT" });
    const first = await login();
    await prisma.user.update({ where: { id: user.id }, data: { status: "DISABLED" } });

    const response = await request(app).post("/auth/refresh").send({ refreshToken: first.refreshToken });

    expect(response.status).toBe(401);
  });

  it("ne stocke jamais le refresh token en clair", async () => {
    await createUser({ email: "agent@test.local", role: "AGENT" });
    const first = await login();

    const stored = await prisma.refreshToken.findMany();

    expect(stored).toHaveLength(1);
    expect(stored[0]!.tokenHash).not.toBe(first.refreshToken);
  });
});

describe("POST /auth/logout", () => {
  it("révoque le refresh token puis reste idempotent", async () => {
    await createUser({ email: "agent@test.local", role: "AGENT" });
    const first = await login();

    const logout = await request(app).post("/auth/logout").send({ refreshToken: first.refreshToken });
    const again = await request(app).post("/auth/logout").send({ refreshToken: first.refreshToken });
    const refresh = await request(app).post("/auth/refresh").send({ refreshToken: first.refreshToken });

    expect(logout.status).toBe(204);
    expect(again.status).toBe(204);
    expect(refresh.status).toBe(401);
  });
});

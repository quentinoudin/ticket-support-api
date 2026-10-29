import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import { app } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { createUser, resetDatabase, TEST_PASSWORD, tokenFor } from "./helpers.js";

beforeEach(resetDatabase);

async function setup() {
  const superAdmin = await createUser({ email: "root@test.local", role: "SUPER_ADMIN" });
  const admin = await createUser({ email: "admin@test.local", role: "ADMIN" });
  const otherAdmin = await createUser({ email: "admin2@test.local", role: "ADMIN" });
  const agent = await createUser({ email: "agent@test.local", role: "AGENT" });
  const user = await createUser({ email: "user@test.local", role: "USER" });

  return {
    superAdmin,
    admin,
    otherAdmin,
    agent,
    user,
    superToken: await tokenFor(superAdmin),
    adminToken: await tokenFor(admin),
    agentToken: await tokenFor(agent),
  };
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

describe("accès à /users", () => {
  it("refuse sans jeton (401) et aux rôles AGENT / USER (403)", async () => {
    const { agentToken } = await setup();

    const anonymous = await request(app).get("/users");
    const agent = await request(app).get("/users").set(auth(agentToken));

    expect(anonymous.status).toBe(401);
    expect(agent.status).toBe(403);
  });
});

describe("GET /users", () => {
  it("le Super Admin voit les ADMIN, AGENT et USER mais jamais les SUPER_ADMIN", async () => {
    const { superToken } = await setup();

    const response = await request(app).get("/users").set(auth(superToken));

    expect(response.status).toBe(200);
    const emails = response.body.data.map((u: { email: string }) => u.email).sort();
    expect(emails).toEqual(["admin2@test.local", "admin@test.local", "agent@test.local", "user@test.local"]);
    expect(JSON.stringify(response.body)).not.toContain("passwordHash");
    expect(response.body.pagination.total).toBe(4);
  });

  it("un Admin ne voit que les AGENT et USER", async () => {
    const { adminToken } = await setup();

    const response = await request(app).get("/users").set(auth(adminToken));

    const emails = response.body.data.map((u: { email: string }) => u.email).sort();
    expect(emails).toEqual(["agent@test.local", "user@test.local"]);
  });

  it("filtre par rôle, statut et recherche, avec pagination", async () => {
    const { superToken } = await setup();
    await createUser({ email: "off@test.local", role: "AGENT", status: "DISABLED" });

    const byStatus = await request(app).get("/users?status=DISABLED").set(auth(superToken));
    const byRole = await request(app).get("/users?role=ADMIN&limit=1&page=2").set(auth(superToken));
    const bySearch = await request(app).get("/users?search=USER@").set(auth(superToken));

    expect(byStatus.body.data.map((u: { email: string }) => u.email)).toEqual(["off@test.local"]);
    expect(byRole.body.data).toHaveLength(1);
    expect(byRole.body.pagination).toMatchObject({ page: 2, limit: 1, total: 2, totalPages: 2 });
    expect(bySearch.body.data.map((u: { email: string }) => u.email)).toEqual(["user@test.local"]);
  });

  it("renvoie 400 pour un filtre invalide", async () => {
    const { superToken } = await setup();

    const response = await request(app).get("/users?role=SUPER_ADMIN").set(auth(superToken));

    expect(response.status).toBe(400);
  });
});

describe("GET /users/super-admin", () => {
  it("n'est visible que par le Super Admin", async () => {
    const { superToken, adminToken } = await setup();

    const asSuper = await request(app).get("/users/super-admin").set(auth(superToken));
    const asAdmin = await request(app).get("/users/super-admin").set(auth(adminToken));

    expect(asSuper.status).toBe(200);
    expect(asSuper.body.data).toMatchObject({ email: "root@test.local", role: "SUPER_ADMIN" });
    expect(asAdmin.status).toBe(403);
  });
});

describe("GET /users/:id", () => {
  it("renvoie 404 pour un compte hors de portée, sans révéler qu'il existe", async () => {
    const { adminToken, otherAdmin, superAdmin, agent } = await setup();

    const ownLevel = await request(app).get(`/users/${otherAdmin.id}`).set(auth(adminToken));
    const superAccount = await request(app).get(`/users/${superAdmin.id}`).set(auth(adminToken));
    const inScope = await request(app).get(`/users/${agent.id}`).set(auth(adminToken));
    const badId = await request(app).get("/users/pas-un-uuid").set(auth(adminToken));

    expect(ownLevel.status).toBe(404);
    expect(superAccount.status).toBe(404);
    expect(inScope.status).toBe(200);
    expect(badId.status).toBe(400);
  });
});

describe("PATCH /users/:id", () => {
  it("modifie le rôle et l'email dans la portée de l'acteur", async () => {
    const { adminToken, agent } = await setup();

    const response = await request(app)
      .patch(`/users/${agent.id}`)
      .set(auth(adminToken))
      .send({ role: "USER", email: " NEW@test.local " });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ role: "USER", email: "new@test.local" });
  });

  it("interdit à un Admin de promouvoir en ADMIN, et au Super Admin de créer un SUPER_ADMIN", async () => {
    const { adminToken, superToken, agent } = await setup();

    const adminPromotes = await request(app)
      .patch(`/users/${agent.id}`)
      .set(auth(adminToken))
      .send({ role: "ADMIN" });
    const superPromotes = await request(app)
      .patch(`/users/${agent.id}`)
      .set(auth(superToken))
      .send({ role: "SUPER_ADMIN" });
    const superAllowed = await request(app)
      .patch(`/users/${agent.id}`)
      .set(auth(superToken))
      .send({ role: "ADMIN" });

    expect(adminPromotes.status).toBe(403);
    expect(superPromotes.status).toBe(400);
    expect(superAllowed.status).toBe(200);
  });

  it("refuse un email déjà pris (409), un corps vide (400) et toute modification de son propre compte (404)", async () => {
    const { superToken, adminToken, admin, superAdmin, agent } = await setup();

    const duplicate = await request(app)
      .patch(`/users/${agent.id}`)
      .set(auth(adminToken))
      .send({ email: "user@test.local" });
    const empty = await request(app).patch(`/users/${agent.id}`).set(auth(adminToken)).send({});
    const selfBySuper = await request(app)
      .patch(`/users/${superAdmin.id}`)
      .set(auth(superToken))
      .send({ role: "USER" });
    const selfByAdmin = await request(app).patch(`/users/${admin.id}`).set(auth(adminToken)).send({ role: "USER" });

    expect(duplicate.status).toBe(409);
    expect(empty.status).toBe(400);
    expect(selfBySuper.status).toBe(404);
    expect(selfByAdmin.status).toBe(404);
  });
});

describe("désactivation et réactivation", () => {
  it("coupe l'accès et les refresh tokens, puis réactive le compte", async () => {
    const { adminToken, agent } = await setup();
    const login = await request(app).post("/auth/login").send({ email: agent.email, password: TEST_PASSWORD });
    const { accessToken, refreshToken } = login.body.data;

    const disabled = await request(app).post(`/users/${agent.id}/disable`).set(auth(adminToken));
    const meAfter = await request(app).get("/auth/me").set(auth(accessToken));
    const refreshAfter = await request(app).post("/auth/refresh").send({ refreshToken });
    const loginAfter = await request(app).post("/auth/login").send({ email: agent.email, password: TEST_PASSWORD });

    expect(disabled.status).toBe(200);
    expect(disabled.body.data.status).toBe("DISABLED");
    expect(meAfter.status).toBe(401);
    expect(refreshAfter.status).toBe(401);
    expect(loginAfter.status).toBe(403);

    const enabled = await request(app).post(`/users/${agent.id}/enable`).set(auth(adminToken));
    const loginAgain = await request(app).post("/auth/login").send({ email: agent.email, password: TEST_PASSWORD });

    expect(enabled.body.data.status).toBe("ACTIVE");
    expect(loginAgain.status).toBe(200);
  });

  it("remet un compte qui n'a jamais eu de mot de passe à l'état INVITED", async () => {
    const { adminToken } = await setup();
    const invited = await createUser({ email: "wait@test.local", role: "USER", status: "DISABLED", password: null });

    const response = await request(app).post(`/users/${invited.id}/enable`).set(auth(adminToken));

    expect(response.body.data.status).toBe("INVITED");
  });

  it("interdit de se désactiver soi-même", async () => {
    const { superToken, superAdmin } = await setup();

    const response = await request(app).post(`/users/${superAdmin.id}/disable`).set(auth(superToken));

    expect(response.status).toBe(404);
  });
});

describe("DELETE /users/:id", () => {
  it("est réservé au Super Admin et supprime le compte", async () => {
    const { superToken, adminToken, agent } = await setup();

    const asAdmin = await request(app).delete(`/users/${agent.id}`).set(auth(adminToken));
    const asSuper = await request(app).delete(`/users/${agent.id}`).set(auth(superToken));

    expect(asAdmin.status).toBe(403);
    expect(asSuper.status).toBe(204);
    expect(await prisma.user.findUnique({ where: { id: agent.id } })).toBeNull();
  });

  it("ne peut jamais supprimer le Super Admin", async () => {
    const { superToken, superAdmin } = await setup();

    const response = await request(app).delete(`/users/${superAdmin.id}`).set(auth(superToken));

    expect(response.status).toBe(404);
    expect(await prisma.user.findUnique({ where: { id: superAdmin.id } })).not.toBeNull();
  });
});

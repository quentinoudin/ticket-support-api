import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import { redactSensitive } from "../src/ai/guards.js";
import { app } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { passwordSchema } from "../src/schemas/auth.schema.js";
import { createUser, resetDatabase, TEST_PASSWORD, tokenFor } from "./helpers.js";

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

beforeEach(resetDatabase);

describe("VULN-006 : sessions révocables", () => {
  it("le jeton d'accès cesse de fonctionner dès la déconnexion", async () => {
    const user = await createUser({ email: "u@test.local", role: "USER" });
    const login = await request(app).post("/auth/login").send({ email: user.email, password: TEST_PASSWORD });
    const { accessToken, refreshToken } = login.body.data;

    expect((await request(app).get("/auth/me").set(auth(accessToken))).status).toBe(200);
    await request(app).post("/auth/logout").send({ refreshToken });

    expect((await request(app).get("/auth/me").set(auth(accessToken))).status).toBe(401);
  });

  it("le jeton d'accès survit à la rotation du jeton de rafraîchissement", async () => {
    const user = await createUser({ email: "u@test.local", role: "USER" });
    const login = await request(app).post("/auth/login").send({ email: user.email, password: TEST_PASSWORD });
    const refreshed = await request(app).post("/auth/refresh").send({ refreshToken: login.body.data.refreshToken });

    expect((await request(app).get("/auth/me").set(auth(refreshed.body.data.accessToken))).status).toBe(200);
  });
});

describe("VULN-008 : vue publique des tickets", () => {
  it("un USER ne reçoit pas les champs internes, l'équipe support les reçoit", async () => {
    const owner = await createUser({ email: "u@test.local", role: "USER" });
    await createUser({ email: "a@test.local", role: "AGENT" });
    const created = await request(app).post("/tickets").set(auth(await tokenFor(owner))).send({ title: "T", description: "D" });
    const id = created.body.data.id;

    const asUser = await request(app).get(`/tickets/${id}`).set(auth(await tokenFor(owner)));
    const asAgent = await request(app).get(`/tickets/${id}`).set(auth(await tokenFor({ email: "a@test.local" })));

    for (const field of ["createdById", "requestedPriority", "priorityLockedByHuman", "aiPriorityReason", "aiCategory", "aiEscalationReason"]) {
      expect(asUser.body.data).not.toHaveProperty(field);
      expect(asAgent.body.data).toHaveProperty(field);
    }
  });
});

describe("VULN-010 : taille de la description", () => {
  it("refuse une description de plus de 4000 caractères", async () => {
    const owner = await createUser({ email: "u@test.local", role: "USER" });
    const token = await tokenFor(owner);

    const big = await request(app).post("/tickets").set(auth(token)).send({ title: "T", description: "A".repeat(95_000) });
    const ok = await request(app).post("/tickets").set(auth(token)).send({ title: "T", description: "A".repeat(4000) });

    expect(big.status).toBe(400);
    expect(ok.status).toBe(201);
    expect(await prisma.ticket.count()).toBe(1);
  });
});

describe("VULN-012 : mots de passe", () => {
  it("refuse les mots de passe courants et ceux de moins de 12 caractères", () => {
    for (const weak of ["Abcdefgh12", "Password1234", "Azerty123456", "Motdepasse2026"]) {
      expect(passwordSchema.safeParse(weak).success, weak).toBe(false);
    }
    expect(passwordSchema.safeParse("Cheval-Pile-8842").success).toBe(true);
  });
});

describe("VULN-007 : masquage avant envoi au LLM", () => {
  it("masque e-mails, IP, téléphone, mots de passe et longues clés", () => {
    const out = redactSensitive(
      "Je suis jean@entreprise.fr, IP 192.168.10.45, mon mot de passe est Hiver2026!Secret, tel 06 12 34 56 78, clé sk-abcdefghijklmnopqrstuvwxyz0123456789",
    );
    for (const leak of ["jean@entreprise.fr", "192.168.10.45", "Hiver2026", "06 12 34 56 78", "sk-abcdefghijklmnopqrstuvwxyz"]) {
      expect(out).not.toContain(leak);
    }
    expect(out).toContain("[email masqué]");
  });
});

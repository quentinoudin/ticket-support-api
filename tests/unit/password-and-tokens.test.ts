import jwt from "jsonwebtoken";
import { describe, expect, it } from "vitest";

import { env } from "../../src/config/env.js";
import { AppError } from "../../src/errors/app-error.js";
import { hashPassword, verifyPassword } from "../../src/lib/password.js";
import {
  generateOpaqueToken,
  hashToken,
  signAccessToken,
  verifyAccessToken,
} from "../../src/services/token.service.js";

describe("mots de passe", () => {
  it("ne stocke jamais le mot de passe en clair et produit un hash différent à chaque fois", async () => {
    const first = await hashPassword("Motdepasse123");
    const second = await hashPassword("Motdepasse123");

    expect(first).not.toContain("Motdepasse123");
    expect(first).toMatch(/^\$2[aby]\$12\$/);
    expect(first).not.toBe(second);
  });

  it("vérifie le bon mot de passe et refuse les autres", async () => {
    const hash = await hashPassword("Motdepasse123");

    expect(await verifyPassword("Motdepasse123", hash)).toBe(true);
    expect(await verifyPassword("motdepasse123", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
  });

  it("refuse toujours quand il n'y a pas de hash (compte invité ou inconnu)", async () => {
    expect(await verifyPassword("Motdepasse123", null)).toBe(false);
    expect(await verifyPassword("mot-de-passe-factice", null)).toBe(false);
  });
});

describe("jetons opaques", () => {
  it("génère des jetons longs et uniques", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateOpaqueToken()));

    expect(tokens.size).toBe(50);
    for (const token of tokens) {
      expect(token.length).toBeGreaterThanOrEqual(43);
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("hache de façon stable, sans jamais renvoyer le jeton", () => {
    const token = generateOpaqueToken();

    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).not.toContain(token);
    expect(hashToken(token)).not.toBe(hashToken(`${token}x`));
  });
});

describe("access token JWT", () => {
  const user = { id: "5b0c1a52-7c4e-4a2b-9f0d-2f6f2f6f2f6f", role: "AGENT" as const };

  it("contient l'identifiant et le rôle", () => {
    const payload = verifyAccessToken(signAccessToken(user, "session-1"));

    expect(payload).toEqual({ sub: user.id, role: "AGENT", sid: "session-1" });
  });

  it("refuse un jeton modifié, signé avec un autre secret ou expiré", () => {
    const valid = signAccessToken(user, "session-1");
    const tampered = `${valid.slice(0, -4)}AAAA`;
    const otherSecret = jwt.sign({ role: "SUPER_ADMIN" }, "un-autre-secret-de-plus-de-32-caracteres!", {
      subject: user.id,
    });
    const expired = jwt.sign({ role: "AGENT" }, env.JWT_ACCESS_SECRET, { subject: user.id, expiresIn: -10 });

    for (const token of [tampered, otherSecret, expired, "n-importe-quoi", ""]) {
      expect(() => verifyAccessToken(token)).toThrow(AppError);
    }
  });

  it("refuse l'algorithme « none » (jeton non signé)", () => {
    const unsigned = jwt.sign({ role: "SUPER_ADMIN" }, "", { algorithm: "none", subject: user.id });

    expect(() => verifyAccessToken(unsigned)).toThrow(AppError);
  });

  it("refuse un jeton sans identifiant", () => {
    const noSubject = jwt.sign({ role: "AGENT" }, env.JWT_ACCESS_SECRET);

    expect(() => verifyAccessToken(noSubject)).toThrow(AppError);
  });
});

import { createHash, randomBytes, randomUUID } from "node:crypto";

import jwt, { type SignOptions } from "jsonwebtoken";

import { env } from "../config/env.js";
import { AppError } from "../errors/app-error.js";
import type { OneTimeTokenType, UserRole } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";

export interface AccessTokenPayload {
  sub: string;
  role: UserRole;
  // Identifiant de la session (famille de jetons de rafraîchissement) à laquelle ce jeton est lié.
  sid: string;
}

export function signAccessToken(user: { id: string; role: UserRole }, sessionId: string): string {
  return jwt.sign({ role: user.role, sid: sessionId }, env.JWT_ACCESS_SECRET, {
    subject: user.id,
    expiresIn: env.JWT_ACCESS_TTL as SignOptions["expiresIn"],
    algorithm: "HS256",
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ["HS256"] });

    if (typeof payload === "string" || typeof payload.sub !== "string" || typeof payload.sid !== "string") {
      throw new Error("Payload invalide");
    }

    return { sub: payload.sub, role: payload.role as UserRole, sid: payload.sid };
  } catch {
    throw new AppError("Jeton d'accès invalide ou expiré", 401);
  }
}

// --- Jetons opaques (refresh, invitation, reset) : seul le hash SHA-256 est stocké ---

export function generateOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function issueRefreshToken(userId: string, familyId: string = randomUUID()) {
  const token = generateOpaqueToken();
  const expiresAt = new Date(Date.now() + env.REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);

  const record = await prisma.refreshToken.create({
    data: { userId, familyId, tokenHash: hashToken(token), expiresAt },
  });

  return { token, id: record.id, familyId };
}

// Une session est vivante tant que sa famille a un jeton de rafraîchissement ni révoqué ni expiré.
// Déconnexion, réinitialisation du mot de passe, désactivation : tout coupe aussi les jetons d'accès.
export async function isSessionActive(sessionId: string): Promise<boolean> {
  const alive = await prisma.refreshToken.findFirst({
    where: { familyId: sessionId, revokedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true },
  });

  return alive !== null;
}

// Émet un jeton à usage unique et invalide les précédents du même type pour cet utilisateur.
export async function issueOneTimeToken(userId: string, type: OneTimeTokenType, ttlMs: number) {
  const token = generateOpaqueToken();

  await prisma.$transaction([
    prisma.oneTimeToken.updateMany({
      where: { userId, type, usedAt: null },
      data: { usedAt: new Date() },
    }),
    prisma.oneTimeToken.create({
      data: { userId, type, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + ttlMs) },
    }),
  ]);

  return token;
}

// Consomme le jeton de façon atomique : deux requêtes simultanées ne peuvent pas l'utiliser toutes les deux.
export async function consumeOneTimeToken(token: string, type: OneTimeTokenType) {
  const tokenHash = hashToken(token);

  const consumed = await prisma.oneTimeToken.updateMany({
    where: { tokenHash, type, usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() },
  });

  if (consumed.count === 0) {
    throw new AppError("Lien invalide ou expiré", 400);
  }

  const record = await prisma.oneTimeToken.findUniqueOrThrow({
    where: { tokenHash },
    include: { user: true },
  });

  return record.user;
}

export function revokeRefreshFamily(familyId: string) {
  return prisma.refreshToken.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export function revokeAllRefreshTokens(userId: string) {
  return prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

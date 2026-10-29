import { createHash, randomBytes, randomUUID } from "node:crypto";

import jwt, { type SignOptions } from "jsonwebtoken";

import { env } from "../config/env.js";
import { AppError } from "../errors/app-error.js";
import type { UserRole } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";

export interface AccessTokenPayload {
  sub: string;
  role: UserRole;
}

export function signAccessToken(user: { id: string; role: UserRole }): string {
  return jwt.sign({ role: user.role }, env.JWT_ACCESS_SECRET, {
    subject: user.id,
    expiresIn: env.JWT_ACCESS_TTL as SignOptions["expiresIn"],
    algorithm: "HS256",
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ["HS256"] });

    if (typeof payload === "string" || typeof payload.sub !== "string") {
      throw new Error("Payload invalide");
    }

    return { sub: payload.sub, role: payload.role as UserRole };
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

  return { token, id: record.id };
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

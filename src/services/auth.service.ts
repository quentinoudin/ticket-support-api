import { AppError } from "../errors/app-error.js";
import { prisma } from "../lib/prisma.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import type { AcceptInviteInput, LoginInput } from "../schemas/auth.schema.js";
import {
  consumeOneTimeToken,
  hashToken,
  issueRefreshToken,
  revokeRefreshFamily,
  signAccessToken,
} from "./token.service.js";

const INVALID_CREDENTIALS = "Email ou mot de passe incorrect";
const INVALID_REFRESH = "Jeton de rafraîchissement invalide ou expiré";

export function toPublicUser(user: { id: string; email: string; role: string; status: string }) {
  return { id: user.id, email: user.email, role: user.role, status: user.status };
}

export async function login({ email, password }: LoginInput) {
  const user = await prisma.user.findUnique({ where: { email } });

  // Même réponse pour un email inconnu, un compte invité ou un mauvais mot de passe.
  const passwordMatches = await verifyPassword(password, user?.passwordHash ?? null);

  if (!user || !passwordMatches) {
    throw new AppError(INVALID_CREDENTIALS, 401);
  }

  if (user.status === "DISABLED") {
    throw new AppError("Ce compte est désactivé", 403);
  }

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  const refresh = await issueRefreshToken(user.id);

  return {
    accessToken: signAccessToken(user),
    refreshToken: refresh.token,
    user: toPublicUser(user),
  };
}

export async function acceptInvite({ token, password }: AcceptInviteInput) {
  const user = await consumeOneTimeToken(token, "INVITE");

  if (user.status !== "INVITED") {
    throw new AppError("Lien invalide ou expiré", 400);
  }

  const activated = await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(password), status: "ACTIVE" },
  });

  return toPublicUser(activated);
}

export async function refresh(refreshToken: string) {
  const record = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashToken(refreshToken) },
    include: { user: true },
  });

  if (!record) {
    throw new AppError(INVALID_REFRESH, 401);
  }

  // Un jeton déjà utilisé qui revient est un signe de vol : on coupe toute la chaîne.
  if (record.revokedAt) {
    await revokeRefreshFamily(record.familyId);
    throw new AppError(INVALID_REFRESH, 401);
  }

  if (record.expiresAt <= new Date()) {
    throw new AppError(INVALID_REFRESH, 401);
  }

  if (record.user.status !== "ACTIVE") {
    await revokeRefreshFamily(record.familyId);
    throw new AppError(INVALID_REFRESH, 401);
  }

  // Révocation atomique : si deux requêtes arrivent en même temps, une seule passe.
  const revoked = await prisma.refreshToken.updateMany({
    where: { id: record.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  if (revoked.count === 0) {
    await revokeRefreshFamily(record.familyId);
    throw new AppError(INVALID_REFRESH, 401);
  }

  const next = await issueRefreshToken(record.userId, record.familyId);
  await prisma.refreshToken.update({ where: { id: record.id }, data: { replacedById: next.id } });

  return {
    accessToken: signAccessToken(record.user),
    refreshToken: next.token,
  };
}

export async function logout(refreshToken: string) {
  const record = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(refreshToken) } });

  // Idempotent : un jeton inconnu ne révèle rien.
  if (record) {
    await revokeRefreshFamily(record.familyId);
  }
}

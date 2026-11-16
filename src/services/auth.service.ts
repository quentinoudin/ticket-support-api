import { env } from "../config/env.js";
import { AppError } from "../errors/app-error.js";
import { prisma } from "../lib/prisma.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import type {
  AcceptInviteInput,
  ForgotPasswordInput,
  LoginInput,
  ResetPasswordInput,
} from "../schemas/auth.schema.js";
import { sendPasswordResetEmail } from "./mail.service.js";
import {
  consumeOneTimeToken,
  hashToken,
  issueOneTimeToken,
  issueRefreshToken,
  revokeAllRefreshTokens,
  revokeRefreshFamily,
  signAccessToken,
} from "./token.service.js";

const INVALID_CREDENTIALS = "Email ou mot de passe incorrect";
const INVALID_REFRESH = "Jeton de rafraîchissement invalide ou expiré";

export function toPublicUser(user: { id: string; email: string; role: string; status: string }) {
  return { id: user.id, email: user.email, role: user.role, status: user.status };
}

// Incrémente le compteur d'échecs ; à la limite, verrouille le compte et remet le compteur à zéro.
async function registerFailedLogin(userId: string) {
  const { failedLoginCount } = await prisma.user.update({
    where: { id: userId },
    data: { failedLoginCount: { increment: 1 } },
    select: { failedLoginCount: true },
  });

  if (failedLoginCount >= env.LOGIN_MAX_ATTEMPTS) {
    await prisma.user.update({
      where: { id: userId },
      data: {
        failedLoginCount: 0,
        lockedUntil: new Date(Date.now() + env.LOGIN_LOCK_MINUTES * 60 * 1000),
      },
    });
  }
}

export async function login({ email, password }: LoginInput) {
  const user = await prisma.user.findUnique({ where: { email } });

  // Un compte verrouillé refuse toute tentative, même avec le bon mot de passe.
  if (user?.lockedUntil && user.lockedUntil > new Date()) {
    throw new AppError("Compte temporairement verrouillé suite à trop d'échecs, réessayez plus tard", 429);
  }

  // Même réponse pour un email inconnu, un compte invité ou un mauvais mot de passe.
  const passwordMatches = await verifyPassword(password, user?.passwordHash ?? null);

  if (!user || !passwordMatches) {
    if (user) {
      await registerFailedLogin(user.id);
    }

    throw new AppError(INVALID_CREDENTIALS, 401);
  }

  if (user.status === "DISABLED") {
    throw new AppError("Ce compte est désactivé", 403);
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null },
  });

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

// Ne révèle jamais si l'email existe : l'appelant répond toujours la même chose.
export async function forgotPassword({ email }: ForgotPasswordInput) {
  const user = await prisma.user.findUnique({ where: { email } });

  if (!user || user.status !== "ACTIVE") {
    return;
  }

  const token = await issueOneTimeToken(user.id, "PASSWORD_RESET", env.RESET_TTL_MINUTES * 60 * 1000);

  try {
    await sendPasswordResetEmail(user.email, token);
  } catch (error) {
    console.error("Échec d'envoi de l'email de réinitialisation :", error instanceof Error ? error.message : error);
  }
}

export async function resetPassword({ token, password }: ResetPasswordInput) {
  const user = await consumeOneTimeToken(token, "PASSWORD_RESET");

  if (user.status !== "ACTIVE") {
    throw new AppError("Lien invalide ou expiré", 400);
  }

  // Une réinitialisation réussie lève aussi un éventuel verrouillage.
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(password), failedLoginCount: 0, lockedUntil: null },
  });

  // Les sessions ouvertes et les autres liens de réinitialisation ne doivent plus fonctionner.
  await revokeAllRefreshTokens(user.id);
  await prisma.oneTimeToken.updateMany({
    where: { userId: user.id, type: "PASSWORD_RESET", usedAt: null },
    data: { usedAt: new Date() },
  });
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

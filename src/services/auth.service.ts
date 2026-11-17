import { env } from "../config/env.js";
import { AppError } from "../errors/app-error.js";
import { prisma } from "../lib/prisma.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { getRequestContext } from "../lib/request-context.js";
import type {
  AcceptInviteInput,
  ForgotPasswordInput,
  LoginInput,
  ResetPasswordInput,
} from "../schemas/auth.schema.js";
import { recordAudit } from "./audit.service.js";
import { clearFailures, clearFailuresForEmail, isThrottled, registerFailure } from "./login-throttle.js";
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

const TOO_MANY_ATTEMPTS = "Trop de tentatives de connexion, réessayez dans quelques minutes";

export async function login({ email, password }: LoginInput) {
  const ip = getRequestContext()?.ip ?? "inconnue";

  // Blocage par couple (email, IP) : identique pour un compte existant ou non, et sans effet sur
  // le propriétaire légitime qui se connecte depuis une autre adresse.
  if (isThrottled(email, ip)) {
    throw new AppError(TOO_MANY_ATTEMPTS, 429);
  }

  const user = await prisma.user.findUnique({ where: { email } });

  // Même réponse pour un email inconnu, un compte invité ou un mauvais mot de passe.
  const passwordMatches = await verifyPassword(password, user?.passwordHash ?? null);

  if (!user || !passwordMatches) {
    // L'email tenté est conservé (jamais le mot de passe) pour repérer les attaques ciblées.
    await recordAudit({
      action: "LOGIN_FAILED",
      actor: { email },
      ...(user && { targetType: "User" as const, targetId: user.id }),
    });

    if (registerFailure(email, ip)) {
      await recordAudit({
        action: "ACCOUNT_LOCKED",
        actor: { email },
        ...(user && { targetType: "User" as const, targetId: user.id }),
        metadata: { lockMinutes: env.LOGIN_LOCK_MINUTES, scope: "email+ip" },
      });
    }

    throw new AppError(INVALID_CREDENTIALS, 401);
  }

  clearFailures(email, ip);

  if (user.status === "DISABLED") {
    await recordAudit({
      action: "LOGIN_FAILED",
      actor: { id: user.id, email: user.email },
      targetType: "User",
      targetId: user.id,
      metadata: { reason: "account_disabled" },
    });

    throw new AppError("Ce compte est désactivé", 403);
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null },
  });

  await recordAudit({
    action: "LOGIN_SUCCESS",
    actor: { id: user.id, email: user.email },
    targetType: "User",
    targetId: user.id,
  });

  const refresh = await issueRefreshToken(user.id);

  return {
    accessToken: signAccessToken(user, refresh.familyId),
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

  await recordAudit({
    action: "INVITE_ACCEPTED",
    actor: { id: activated.id, email: activated.email },
    targetType: "User",
    targetId: activated.id,
  });

  return toPublicUser(activated);
}

async function processForgotPassword({ email }: ForgotPasswordInput) {
  const user = await prisma.user.findUnique({ where: { email } });

  if (!user || user.status !== "ACTIVE") {
    return;
  }

  const token = await issueOneTimeToken(user.id, "PASSWORD_RESET", env.RESET_TTL_MINUTES * 60 * 1000);

  await recordAudit({
    action: "PASSWORD_RESET_REQUESTED",
    actor: { id: user.id, email: user.email },
    targetType: "User",
    targetId: user.id,
  });

  try {
    await sendPasswordResetEmail(user.email, token);
  } catch (error) {
    console.error("Échec d'envoi de l'email de réinitialisation :", error instanceof Error ? error.message : error);
  }
}

// Travail lancé en arrière-plan : la réponse part tout de suite, que le compte existe ou non, donc
// son temps de réponse ne révèle rien. Les tests attendent la fin avec settleBackgroundWork().
const backgroundWork = new Set<Promise<void>>();

export function settleBackgroundWork(): Promise<unknown> {
  return Promise.allSettled([...backgroundWork]);
}

// Ne révèle jamais si l'email existe : l'appelant répond toujours la même chose, aussi vite.
export function forgotPassword(input: ForgotPasswordInput): void {
  const work = processForgotPassword(input)
    .catch((error: unknown) => {
      console.error("Échec du traitement de la réinitialisation :", error instanceof Error ? error.message : error);
    })
    .finally(() => backgroundWork.delete(work));

  backgroundWork.add(work);
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
  clearFailuresForEmail(user.email);

  // Les sessions ouvertes et les autres liens de réinitialisation ne doivent plus fonctionner.
  await revokeAllRefreshTokens(user.id);
  await prisma.oneTimeToken.updateMany({
    where: { userId: user.id, type: "PASSWORD_RESET", usedAt: null },
    data: { usedAt: new Date() },
  });

  await recordAudit({
    action: "PASSWORD_RESET_COMPLETED",
    actor: { id: user.id, email: user.email },
    targetType: "User",
    targetId: user.id,
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
    accessToken: signAccessToken(record.user, record.familyId),
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

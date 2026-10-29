import { AppError } from "../errors/app-error.js";
import { prisma } from "../lib/prisma.js";
import { verifyPassword } from "../lib/password.js";
import type { LoginInput } from "../schemas/auth.schema.js";
import { signAccessToken } from "./token.service.js";

const INVALID_CREDENTIALS = "Email ou mot de passe incorrect";

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

  return {
    accessToken: signAccessToken(user),
    user: toPublicUser(user),
  };
}

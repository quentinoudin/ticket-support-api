import { canManageRole, manageableRoles } from "../auth/permissions.js";
import { env } from "../config/env.js";
import { AppError } from "../errors/app-error.js";
import type { Prisma, UserRole } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import type { CreateUserInput, ListUsersInput, UpdateUserInput } from "../schemas/user.schema.js";
import { diffFields, recordAudit } from "./audit.service.js";
import { sendInvitationEmail } from "./mail.service.js";
import { issueOneTimeToken, revokeAllRefreshTokens } from "./token.service.js";

export interface Actor {
  id: string;
  role: UserRole;
}

const userSelect = {
  id: true,
  email: true,
  role: true,
  status: true,
  createdById: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

const NOT_FOUND = "Utilisateur introuvable";

// Un compte hors de la portée de l'acteur est traité comme inexistant (404, pas 403).
// Cela couvre aussi l'acteur lui-même : un Admin ne gère pas les Admin, et le Super Admin
// n'est jamais gérable, donc personne ne peut se modifier, se désactiver ou se supprimer ici.
async function getManagedUser(actor: Actor, id: string) {
  const user = await prisma.user.findUnique({ where: { id }, select: userSelect });

  if (!user || !canManageRole(actor.role, user.role)) {
    throw new AppError(NOT_FOUND, 404);
  }

  return user;
}

// Émet un nouveau jeton d'invitation et l'envoie. Un échec d'envoi n'annule pas le compte :
// on renvoie `false` et l'invitation peut être renvoyée via POST /users/:id/resend-invite.
async function sendInvitation(userId: string, email: string): Promise<boolean> {
  const token = await issueOneTimeToken(userId, "INVITE", env.INVITE_TTL_HOURS * 60 * 60 * 1000);

  try {
    await sendInvitationEmail(email, token);
    return true;
  } catch (error) {
    console.error("Échec d'envoi de l'email d'invitation :", error instanceof Error ? error.message : error);
    return false;
  }
}

export async function createUser(actor: Actor, input: CreateUserInput) {
  if (!canManageRole(actor.role, input.role)) {
    throw new AppError("Vous ne pouvez pas attribuer ce rôle", 403);
  }

  const user = await prisma.user.create({
    data: { email: input.email, role: input.role, status: "INVITED", createdById: actor.id },
    select: userSelect,
  });

  const emailSent = await sendInvitation(user.id, user.email);

  await recordAudit({
    action: "USER_INVITED",
    targetType: "User",
    targetId: user.id,
    metadata: { email: user.email, role: user.role, emailSent },
  });

  return { user, emailSent };
}

export async function resendInvitation(actor: Actor, id: string) {
  const target = await getManagedUser(actor, id);

  if (target.status !== "INVITED") {
    throw new AppError("Ce compte a déjà été activé", 409);
  }

  const emailSent = await sendInvitation(target.id, target.email);

  await recordAudit({
    action: "USER_INVITE_RESENT",
    targetType: "User",
    targetId: target.id,
    metadata: { email: target.email, emailSent },
  });

  return { user: target, emailSent };
}

export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export async function listUsers(actor: Actor, filters: ListUsersInput) {
  const { page, limit, role, status, search, sortBy, order } = filters;
  const visibleRoles = manageableRoles(actor.role);

  if (role && !visibleRoles.includes(role)) {
    return { users: [], total: 0 };
  }

  const where: Prisma.UserWhereInput = {
    role: { in: role ? [role] : visibleRoles },
    ...(status && { status }),
    // % et _ sont des jokers en SQL : on les échappe pour que la recherche soit littérale.
    ...(search && { email: { contains: escapeLikePattern(search), mode: "insensitive" } }),
  };

  const [users, total] = await prisma.$transaction([
    prisma.user.findMany({
      where,
      select: userSelect,
      orderBy: [{ [sortBy]: order }, { id: "asc" }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.user.count({ where }),
  ]);

  return { users, total };
}

export async function getUser(actor: Actor, id: string) {
  return getManagedUser(actor, id);
}

export async function getSuperAdmin() {
  const superAdmin = await prisma.user.findFirst({ where: { role: "SUPER_ADMIN" }, select: userSelect });

  if (!superAdmin) {
    throw new AppError("Aucun Super Admin n'existe", 404);
  }

  return superAdmin;
}

export async function updateUser(actor: Actor, id: string, input: UpdateUserInput) {
  const before = await getManagedUser(actor, id);

  if (input.role && !canManageRole(actor.role, input.role)) {
    throw new AppError("Vous ne pouvez pas attribuer ce rôle", 403);
  }

  const after = await prisma.user.update({ where: { id }, data: input, select: userSelect });

  // Un changement de rôle est l'événement le plus sensible : il a sa propre entrée.
  if (before.role !== after.role) {
    await recordAudit({
      action: "USER_ROLE_CHANGED",
      targetType: "User",
      targetId: id,
      metadata: diffFields(before, after, ["role"]),
    });
  }

  if (before.email !== after.email) {
    await recordAudit({
      action: "USER_UPDATED",
      targetType: "User",
      targetId: id,
      metadata: diffFields(before, after, ["email"]),
    });
  }

  return after;
}

export async function disableUser(actor: Actor, id: string) {
  const before = await getManagedUser(actor, id);

  const [user] = await prisma.$transaction([
    prisma.user.update({ where: { id }, data: { status: "DISABLED" }, select: userSelect }),
    prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);

  await recordAudit({
    action: "USER_DISABLED",
    targetType: "User",
    targetId: id,
    metadata: { email: before.email, previousStatus: before.status },
  });

  return user;
}

export async function enableUser(actor: Actor, id: string) {
  const target = await getManagedUser(actor, id);

  // Un compte qui n'a jamais défini de mot de passe retourne à l'état « invité ».
  const full = await prisma.user.findUniqueOrThrow({ where: { id: target.id }, select: { passwordHash: true } });
  const status = full.passwordHash ? "ACTIVE" : "INVITED";

  const user = await prisma.user.update({ where: { id }, data: { status }, select: userSelect });

  await recordAudit({
    action: "USER_ENABLED",
    targetType: "User",
    targetId: id,
    metadata: { email: target.email, previousStatus: target.status, status },
  });

  return user;
}

export async function deleteUser(actor: Actor, id: string) {
  const target = await getManagedUser(actor, id);

  await revokeAllRefreshTokens(id);
  await prisma.user.delete({ where: { id } });

  // Le compte n'existe plus : on garde son email et son rôle dans le journal.
  await recordAudit({
    action: "USER_DELETED",
    targetType: "User",
    targetId: id,
    metadata: { email: target.email, role: target.role },
  });
}

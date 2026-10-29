import { canManageRole, manageableRoles } from "../auth/permissions.js";
import { AppError } from "../errors/app-error.js";
import type { Prisma, UserRole } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import type { ListUsersInput, UpdateUserInput } from "../schemas/user.schema.js";
import { revokeAllRefreshTokens } from "./token.service.js";

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

export async function listUsers(actor: Actor, filters: ListUsersInput) {
  const { page, limit, role, status, search } = filters;
  const visibleRoles = manageableRoles(actor.role);

  if (role && !visibleRoles.includes(role)) {
    return { users: [], total: 0 };
  }

  const where: Prisma.UserWhereInput = {
    role: { in: role ? [role] : visibleRoles },
    ...(status && { status }),
    ...(search && { email: { contains: search, mode: "insensitive" } }),
  };

  const [users, total] = await prisma.$transaction([
    prisma.user.findMany({
      where,
      select: userSelect,
      orderBy: { createdAt: "desc" },
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
  await getManagedUser(actor, id);

  if (input.role && !canManageRole(actor.role, input.role)) {
    throw new AppError("Vous ne pouvez pas attribuer ce rôle", 403);
  }

  return prisma.user.update({ where: { id }, data: input, select: userSelect });
}

export async function disableUser(actor: Actor, id: string) {
  await getManagedUser(actor, id);

  const [user] = await prisma.$transaction([
    prisma.user.update({ where: { id }, data: { status: "DISABLED" }, select: userSelect }),
    prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);

  return user;
}

export async function enableUser(actor: Actor, id: string) {
  const target = await getManagedUser(actor, id);

  // Un compte qui n'a jamais défini de mot de passe retourne à l'état « invité ».
  const full = await prisma.user.findUniqueOrThrow({ where: { id: target.id }, select: { passwordHash: true } });
  const status = full.passwordHash ? "ACTIVE" : "INVITED";

  return prisma.user.update({ where: { id }, data: { status }, select: userSelect });
}

export async function deleteUser(actor: Actor, id: string) {
  await getManagedUser(actor, id);

  await revokeAllRefreshTokens(id);
  await prisma.user.delete({ where: { id } });
}

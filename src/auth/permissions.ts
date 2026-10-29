import type { UserRole } from "../generated/prisma/client.js";

export const userRoles = ["SUPER_ADMIN", "ADMIN", "AGENT", "USER"] as const satisfies readonly UserRole[];

// Plus le rang est élevé, plus le rôle a de pouvoir.
const roleRank: Record<UserRole, number> = {
  SUPER_ADMIN: 4,
  ADMIN: 3,
  AGENT: 2,
  USER: 1,
};

export function hasRoleAtLeast(role: UserRole, minimum: UserRole): boolean {
  return roleRank[role] >= roleRank[minimum];
}

// Rôles qu'un acteur peut voir, modifier et attribuer. Le SUPER_ADMIN n'est jamais gérable
// via /users : il n'est exposé que par GET /users/super-admin.
export function manageableRoles(actorRole: UserRole): UserRole[] {
  switch (actorRole) {
    case "SUPER_ADMIN":
      return ["ADMIN", "AGENT", "USER"];
    case "ADMIN":
      return ["AGENT", "USER"];
    default:
      return [];
  }
}

export function canManageRole(actorRole: UserRole, targetRole: UserRole): boolean {
  return manageableRoles(actorRole).includes(targetRole);
}

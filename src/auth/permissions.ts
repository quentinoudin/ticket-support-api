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

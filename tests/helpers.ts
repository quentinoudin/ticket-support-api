import type { UserRole, UserStatus } from "../src/generated/prisma/client.js";
import { hashPassword } from "../src/lib/password.js";
import { prisma } from "../src/lib/prisma.js";

export const TEST_PASSWORD = "Motdepasse123";

export async function resetDatabase() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "RefreshToken", "OneTimeToken", "Ticket", "User" RESTART IDENTITY CASCADE',
  );
}

export async function createUser(
  overrides: { email?: string; role?: UserRole; status?: UserStatus; password?: string | null } = {},
) {
  const password = overrides.password === undefined ? TEST_PASSWORD : overrides.password;

  return prisma.user.create({
    data: {
      email: overrides.email ?? `${(overrides.role ?? "USER").toLowerCase()}-${crypto.randomUUID()}@test.local`,
      passwordHash: password === null ? null : await hashPassword(password),
      role: overrides.role ?? "USER",
      status: overrides.status ?? "ACTIVE",
    },
  });
}

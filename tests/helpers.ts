import type { UserRole, UserStatus } from "../src/generated/prisma/client.js";
import { hashPassword } from "../src/lib/password.js";
import { prisma } from "../src/lib/prisma.js";
import { resetThrottle } from "../src/services/login-throttle.js";

export const TEST_PASSWORD = "Tr0ubadour-Vert-2026";

export interface CapturedEmail {
  to: string;
  subject: string;
  text: string;
}

// Remplace le transport SMTP par une capture en mémoire.
export async function captureEmails(options: { failing?: boolean } = {}) {
  const { setMailTransport } = await import("../src/services/mail.service.js");
  const sent: CapturedEmail[] = [];

  setMailTransport({
    sendMail: (async (message: CapturedEmail) => {
      if (options.failing) {
        throw new Error("SMTP indisponible");
      }
      sent.push({ to: message.to, subject: message.subject, text: message.text });
      return {};
    }) as never,
  });

  return sent;
}

export function extractToken(email: CapturedEmail | undefined): string {
  const match = email?.text.match(/"token": "([^"]+)"/);

  if (!match?.[1]) {
    throw new Error("Aucun jeton trouvé dans l'email");
  }

  return match[1];
}

export async function tokenFor(user: { email: string }): Promise<string> {
  const { default: request } = await import("supertest");
  const { app } = await import("../src/app.js");
  const response = await request(app).post("/auth/login").send({ email: user.email, password: TEST_PASSWORD });
  return response.body.data.accessToken as string;
}

export async function resetDatabase() {
  resetThrottle();
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "RefreshToken", "OneTimeToken", "TicketMessage", "AiJob", "AiRun", "Ticket", "AuditLog", "User" RESTART IDENTITY CASCADE',
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

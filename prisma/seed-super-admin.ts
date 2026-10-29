import { env } from "../src/config/env.js";
import { prisma } from "../src/lib/prisma.js";
import { hashPassword } from "../src/lib/password.js";
import { emailSchema, passwordSchema } from "../src/schemas/auth.schema.js";

async function main() {
  const existing = await prisma.user.findFirst({ where: { role: "SUPER_ADMIN" } });

  if (existing) {
    console.log(`Un Super Admin existe déjà (${existing.email}), rien à faire.`);
    return;
  }

  const email = emailSchema.safeParse(env.SUPER_ADMIN_EMAIL);
  const password = passwordSchema.safeParse(env.SUPER_ADMIN_PASSWORD);

  if (!email.success || !password.success) {
    const problems = [
      ...(email.success ? [] : ["SUPER_ADMIN_EMAIL : " + email.error.issues[0]?.message]),
      ...(password.success ? [] : ["SUPER_ADMIN_PASSWORD : " + password.error.issues[0]?.message]),
    ];
    throw new Error(`Variables du Super Admin invalides :\n- ${problems.join("\n- ")}`);
  }

  await prisma.user.create({
    data: {
      email: email.data,
      passwordHash: await hashPassword(password.data),
      role: "SUPER_ADMIN",
      status: "ACTIVE",
    },
  });

  console.log(`Super Admin créé : ${email.data}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

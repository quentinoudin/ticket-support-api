import "dotenv/config";

import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  APP_URL: z.url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL est obligatoire"),

  JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET doit faire 32 caractères minimum"),
  JWT_ACCESS_TTL: z.string().default("15m"),
  REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(7),
  INVITE_TTL_HOURS: z.coerce.number().int().positive().default(48),
  RESET_TTL_MINUTES: z.coerce.number().int().positive().default(60),

  SMTP_HOST: z.string().default("localhost"),
  SMTP_PORT: z.coerce.number().int().positive().default(1026),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  MAIL_FROM: z.string().default("Support Tickets <no-reply@ticket.local>"),

  SUPER_ADMIN_EMAIL: z.string().optional(),
  SUPER_ADMIN_PASSWORD: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `- ${issue.path.join(".")} : ${issue.message}`)
    .join("\n");
  throw new Error(`Configuration invalide :\n${details}`);
}

export const env = parsed.data;

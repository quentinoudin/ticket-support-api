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

  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().positive().default(15),
  // Nombre de proxys de confiance devant l'API (0 = aucun). Nécessaire pour lire la vraie IP du client.
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  // Documentation publique /docs et /openapi.json : désactivée par défaut en production.
  DOCS_ENABLED: z.stringbool().default(process.env.NODE_ENV !== "production"),

  SMTP_HOST: z.string().default("localhost"),
  SMTP_PORT: z.coerce.number().int().positive().default(1026),
  BREVO_API_KEY: z.string().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  MAIL_FROM: z.string().default("Support Tickets <no-reply@ticket.local>"),

  SUPER_ADMIN_EMAIL: z.string().optional(),
  SUPER_ADMIN_PASSWORD: z.string().optional(),

  // --- Assistant IA (désactivé par défaut) ---
  AI_ENABLED: z.stringbool().default(false),
  // La clé vit uniquement ici : jamais dans le code, les logs ni la CI.
  DEEPSEEK_API_KEY: z.string().optional(),
  DEEPSEEK_BASE_URL: z.url().default("https://api.deepseek.com"),
  AI_MODEL: z.string().min(1).default("deepseek-flash"),
  AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(30_000),
  AI_MAX_TOKENS_TRIAGE: z.coerce.number().int().min(50).max(2000).default(300),
  AI_MAX_TOKENS_REPLY: z.coerce.number().int().min(100).max(4000).default(700),
  // Plafond de jetons par jour pour toute l'application : la clé est partagée.
  AI_DAILY_TOKEN_BUDGET: z.coerce.number().int().positive().default(200_000),
  AI_USER_DAILY_RUNS: z.coerce.number().int().positive().default(20),
  AI_MAX_TURNS: z.coerce.number().int().min(1).max(10).default(3),
  AI_OFFTOPIC_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.8),
  AI_REPLY_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.6),
}).superRefine((config, context) => {
  if (config.AI_ENABLED && !config.DEEPSEEK_API_KEY) {
    context.addIssue({
      code: "custom",
      path: ["DEEPSEEK_API_KEY"],
      message: "DEEPSEEK_API_KEY est obligatoire quand AI_ENABLED=true",
    });
  }
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `- ${issue.path.join(".")} : ${issue.message}`)
    .join("\n");
  throw new Error(`Configuration invalide :\n${details}`);
}

export const env = parsed.data;

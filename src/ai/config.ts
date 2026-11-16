import { env } from "../config/env.js";

// Réglages de l'assistant, copiés depuis l'environnement. L'objet est modifiable pour que les
// tests puissent activer l'IA ou changer un seuil sans toucher aux variables d'environnement.
export const aiConfig = {
  enabled: env.AI_ENABLED,
  model: env.AI_MODEL,
  timeoutMs: env.AI_TIMEOUT_MS,
  maxTokensTriage: env.AI_MAX_TOKENS_TRIAGE,
  maxTokensReply: env.AI_MAX_TOKENS_REPLY,
  dailyTokenBudget: env.AI_DAILY_TOKEN_BUDGET,
  userDailyRuns: env.AI_USER_DAILY_RUNS,
  maxTurns: env.AI_MAX_TURNS,
  offTopicMinConfidence: env.AI_OFFTOPIC_MIN_CONFIDENCE,
  replyMinConfidence: env.AI_REPLY_MIN_CONFIDENCE,
};

export type AiConfig = typeof aiConfig;

import { describe, expect, it } from "vitest";

import { aiConfig } from "../../src/ai/config.js";
import { env } from "../../src/config/env.js";

describe("configuration de l'assistant IA", () => {
  it("est désactivée pendant les tests, avec une clé factice et une adresse inaccessible", () => {
    expect(aiConfig.enabled).toBe(false);
    expect(env.DEEPSEEK_API_KEY).toBe("cle-factice-pour-les-tests");
    expect(env.DEEPSEEK_BASE_URL).toBe("http://127.0.0.1:9");
  });

  it("a des valeurs par défaut prudentes", () => {
    expect(aiConfig.model).toBe("deepseek-flash");
    expect(aiConfig.maxTokensTriage).toBeLessThanOrEqual(500);
    expect(aiConfig.maxTokensReply).toBeLessThanOrEqual(1000);
    expect(aiConfig.dailyTokenBudget).toBeLessThanOrEqual(500_000);
    expect(aiConfig.maxTurns).toBeGreaterThanOrEqual(1);
    expect(aiConfig.offTopicMinConfidence).toBeGreaterThan(aiConfig.replyMinConfidence);
  });
});

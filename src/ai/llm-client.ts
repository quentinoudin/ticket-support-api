import { aiConfig } from "./config.js";
import { env } from "../config/env.js";
import { createDeepseekClient } from "./deepseek-client.js";
import { LlmError, type LlmClient } from "./llm-types.js";

export * from "./llm-types.js";

let client: LlmClient | undefined;

export function getLlmClient(): LlmClient {
  if (!client) {
    // Garde-fou : en test, on n'appelle jamais le vrai fournisseur. Un test qui touche à l'IA
    // doit installer son propre faux client avec setLlmClient().
    if (process.env.NODE_ENV === "test") {
      throw new LlmError("not_configured");
    }

    if (!env.DEEPSEEK_API_KEY) {
      throw new LlmError("not_configured");
    }

    client = createDeepseekClient({
      apiKey: env.DEEPSEEK_API_KEY,
      baseUrl: env.DEEPSEEK_BASE_URL,
      model: aiConfig.model,
      timeoutMs: aiConfig.timeoutMs,
    });
  }

  return client;
}

// Permet aux tests d'injecter un faux client (même idée que setMailTransport).
export function setLlmClient(next: LlmClient | undefined) {
  client = next;
}

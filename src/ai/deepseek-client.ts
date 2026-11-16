import { LlmError, type ChatRequest, type ChatResult, type LlmClient } from "./llm-types.js";

interface DeepseekClientOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  // Nombre de nouvelles tentatives après un échec temporaire (429, 5xx, réseau, contenu vide).
  maxRetries?: number;
  // Injectables pour les tests : pas de vrai réseau, pas d'attente réelle.
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

interface CompletionResponse {
  choices?: { message?: { content?: unknown }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

const MAX_RETRY_AFTER_MS = 5000;
const BASE_BACKOFF_MS = 500;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Estimation grossière quand le fournisseur n'indique pas l'usage : mieux vaut surestimer
// que laisser passer un appel sans le compter dans le budget.
const estimateTokens = (text: string) => Math.ceil(text.length / 3);

function retryDelay(attempt: number, retryAfterHeader: string | null): number {
  const seconds = retryAfterHeader ? Number(retryAfterHeader) : Number.NaN;

  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }

  return BASE_BACKOFF_MS * 2 ** attempt;
}

export function createDeepseekClient(options: DeepseekClientOptions): LlmClient {
  const { apiKey, model, timeoutMs, maxRetries = 2, fetchImpl = fetch, sleep = defaultSleep } = options;
  const url = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  async function attempt(request: ChatRequest): Promise<ChatResult> {
    let response: Response;

    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: request.messages,
          max_tokens: request.maxTokens,
          temperature: request.temperature ?? 0.2,
          stream: false,
          ...(request.json && { response_format: { type: "json_object" } }),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new LlmError(timedOut ? "timeout" : "network");
    }

    if (!response.ok) {
      const error = new LlmError("http", response.status);
      error.retryAfter = response.headers.get("retry-after");
      throw error;
    }

    let payload: CompletionResponse;

    try {
      payload = (await response.json()) as CompletionResponse;
    } catch {
      throw new LlmError("invalid_response");
    }

    const choice = payload.choices?.[0];
    const content = choice?.message?.content;

    if (typeof content !== "string") {
      throw new LlmError("invalid_response");
    }

    // Le fournisseur renvoie parfois un contenu vide ou rempli d'espaces en mode JSON.
    if (content.trim() === "") {
      throw new LlmError("empty");
    }

    // Une sortie coupée par la limite de jetons n'est pas exploitable : inutile de réessayer.
    if (choice?.finish_reason === "length") {
      throw new LlmError("truncated");
    }

    const promptText = request.messages.map((message) => message.content).join("\n");

    return {
      content,
      promptTokens: payload.usage?.prompt_tokens ?? estimateTokens(promptText),
      completionTokens: payload.usage?.completion_tokens ?? estimateTokens(content),
    };
  }

  const isRetryable = (error: LlmError) =>
    error.kind === "timeout" ||
    error.kind === "network" ||
    error.kind === "empty" ||
    (error.kind === "http" && (error.status === 429 || (error.status ?? 0) >= 500));

  return {
    async chat(request) {
      let lastError: LlmError | undefined;

      for (let retry = 0; retry <= maxRetries; retry++) {
        try {
          return await attempt(request);
        } catch (error) {
          if (!(error instanceof LlmError)) {
            throw new LlmError("invalid_response");
          }

          lastError = error;

          if (!isRetryable(error) || retry === maxRetries) {
            throw error;
          }

          await sleep(retryDelay(retry, error.retryAfter));
        }
      }

      throw lastError ?? new LlmError("invalid_response");
    },
  };
}

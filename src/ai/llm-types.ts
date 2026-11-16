export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  maxTokens: number;
  // Demande une sortie JSON (response_format json_object côté fournisseur).
  json?: boolean;
  temperature?: number;
}

export interface ChatResult {
  content: string;
  promptTokens: number;
  completionTokens: number;
}

export interface LlmClient {
  chat(request: ChatRequest): Promise<ChatResult>;
}

export type LlmErrorKind = "timeout" | "network" | "http" | "empty" | "truncated" | "invalid_response" | "not_configured";

// Message volontairement générique : il ne contient jamais la clé, le corps de la requête ni
// la réponse du fournisseur, pour ne rien laisser fuiter dans les logs ou les réponses de l'API.
export class LlmError extends Error {
  // En-tête Retry-After du fournisseur, si présent (sert uniquement à espacer les réessais).
  public retryAfter: string | null = null;

  constructor(
    public readonly kind: LlmErrorKind,
    public readonly status?: number,
  ) {
    super(status ? `Appel IA échoué (${kind}, http ${status})` : `Appel IA échoué (${kind})`);
    this.name = "LlmError";
  }
}

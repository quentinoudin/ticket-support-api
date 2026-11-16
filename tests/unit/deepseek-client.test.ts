import { describe, expect, it, vi } from "vitest";

import { createDeepseekClient } from "../../src/ai/deepseek-client.js";
import { getLlmClient, LlmError, setLlmClient } from "../../src/ai/llm-client.js";

const API_KEY = "sk-cle-secrete-de-test-0123456789";
const messages = [{ role: "user" as const, content: "Mon imprimante ne répond plus" }];

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

const completion = (content: string, extra: Record<string, unknown> = {}) =>
  jsonResponse({
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 12, completion_tokens: 7 },
    ...extra,
  });

function clientWith(fetchImpl: ReturnType<typeof vi.fn>, overrides = {}) {
  const sleep = vi.fn().mockResolvedValue(undefined);
  const client = createDeepseekClient({
    apiKey: API_KEY,
    baseUrl: "https://api.exemple.test/",
    model: "deepseek-flash",
    timeoutMs: 5000,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleep,
    ...overrides,
  });

  return { client, sleep };
}

async function failureOf(promise: Promise<unknown>): Promise<LlmError> {
  try {
    await promise;
  } catch (error) {
    return error as LlmError;
  }

  throw new Error("Une erreur était attendue");
}

describe("requête envoyée au fournisseur", () => {
  it("appelle /chat/completions avec la clé en en-tête et le bon corps", async () => {
    const fetchMock = vi.fn().mockResolvedValue(completion("ok"));
    const { client } = clientWith(fetchMock);

    await client.chat({ messages, maxTokens: 300, json: true });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.exemple.test/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe(`Bearer ${API_KEY}`);

    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      model: "deepseek-flash",
      max_tokens: 300,
      stream: false,
      response_format: { type: "json_object" },
      messages,
    });
    expect(init.body).not.toContain(API_KEY);
  });

  it("n'active le mode JSON que sur demande", async () => {
    const fetchMock = vi.fn().mockResolvedValue(completion("bonjour"));
    const { client } = clientWith(fetchMock);

    await client.chat({ messages, maxTokens: 100 });

    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).response_format).toBeUndefined();
  });

  it("borne l'attente avec un délai maximal", async () => {
    const fetchMock = vi.fn().mockResolvedValue(completion("ok"));
    const { client } = clientWith(fetchMock);

    await client.chat({ messages, maxTokens: 100 });

    expect(fetchMock.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
  });
});

describe("réponse", () => {
  it("renvoie le contenu et l'usage de jetons du fournisseur", async () => {
    const { client } = clientWith(vi.fn().mockResolvedValue(completion('{"a":1}')));

    expect(await client.chat({ messages, maxTokens: 100, json: true })).toEqual({
      content: '{"a":1}',
      promptTokens: 12,
      completionTokens: 7,
    });
  });

  it("estime l'usage quand le fournisseur ne le donne pas, pour ne pas fausser le budget", async () => {
    const response = jsonResponse({ choices: [{ message: { content: "x".repeat(30) }, finish_reason: "stop" }] });
    const { client } = clientWith(vi.fn().mockResolvedValue(response));

    const result = await client.chat({ messages, maxTokens: 100 });

    expect(result.promptTokens).toBeGreaterThan(0);
    expect(result.completionTokens).toBe(10);
  });

  it("refuse une réponse coupée par la limite de jetons, sans réessayer", async () => {
    const truncated = jsonResponse({ choices: [{ message: { content: '{"a":' }, finish_reason: "length" }] });
    const fetchMock = vi.fn().mockResolvedValue(truncated);
    const { client } = clientWith(fetchMock);

    const error = await failureOf(client.chat({ messages, maxTokens: 100, json: true }));

    expect(error.kind).toBe("truncated");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuse une réponse qui n'a pas la forme attendue", async () => {
    for (const body of [{}, { choices: [] }, { choices: [{ message: { content: 42 } }] }]) {
      const { client } = clientWith(vi.fn().mockResolvedValue(jsonResponse(body)));

      expect((await failureOf(client.chat({ messages, maxTokens: 100 }))).kind).toBe("invalid_response");
    }

    const notJson = new Response("<html>", { status: 200 });
    const { client } = clientWith(vi.fn().mockResolvedValue(notJson));
    expect((await failureOf(client.chat({ messages, maxTokens: 100 }))).kind).toBe("invalid_response");
  });
});

describe("réessais", () => {
  it("réessaie après un 429 puis réussit", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 429 }))
      .mockResolvedValueOnce(completion("ok"));
    const { client, sleep } = clientWith(fetchMock);

    const result = await client.chat({ messages, maxTokens: 100 });

    expect(result.content).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("respecte Retry-After, plafonné à 5 secondes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 429, headers: { "retry-after": "2" } }))
      .mockResolvedValueOnce(new Response("{}", { status: 429, headers: { "retry-after": "999" } }))
      .mockResolvedValueOnce(completion("ok"));
    const { client, sleep } = clientWith(fetchMock);

    await client.chat({ messages, maxTokens: 100 });

    expect(sleep.mock.calls.map((call) => call[0])).toEqual([2000, 5000]);
  });

  it("espace les réessais de façon exponentielle sans Retry-After", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(new Response("{}", { status: 500 }))
      .mockResolvedValueOnce(completion("ok"));
    const { client, sleep } = clientWith(fetchMock);

    await client.chat({ messages, maxTokens: 100 });

    expect(sleep.mock.calls.map((call) => call[0])).toEqual([500, 1000]);
  });

  it("abandonne après le nombre maximal de réessais avec l'erreur du fournisseur", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 500 }));
    const { client } = clientWith(fetchMock, { maxRetries: 2 });

    const error = await failureOf(client.chat({ messages, maxTokens: 100 }));

    expect(error).toMatchObject({ kind: "http", status: 500 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([400, 401, 402, 403, 404])("ne réessaie pas après un %i (erreur définitive)", async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status }));
    const { client } = clientWith(fetchMock);

    const error = await failureOf(client.chat({ messages, maxTokens: 100 }));

    expect(error).toMatchObject({ kind: "http", status });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("réessaie après un délai dépassé puis signale un timeout", async () => {
    const timeout = Object.assign(new Error("délai"), { name: "TimeoutError" });
    const fetchMock = vi.fn().mockRejectedValue(timeout);
    const { client } = clientWith(fetchMock);

    const error = await failureOf(client.chat({ messages, maxTokens: 100 }));

    expect(error.kind).toBe("timeout");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("traite une panne réseau comme réessayable", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(completion("ok"));
    const { client } = clientWith(fetchMock);

    expect((await client.chat({ messages, maxTokens: 100 })).content).toBe("ok");
  });

  it("réessaie un contenu vide ou rempli d'espaces, comportement connu du mode JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(completion("   \n ")).mockResolvedValueOnce(completion('{"ok":true}'));
    const { client } = clientWith(fetchMock);

    expect((await client.chat({ messages, maxTokens: 100, json: true })).content).toBe('{"ok":true}');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("signale « empty » si le contenu reste vide après les réessais", async () => {
    const { client } = clientWith(vi.fn().mockImplementation(async () => completion("  ")));

    expect((await failureOf(client.chat({ messages, maxTokens: 100, json: true }))).kind).toBe("empty");
  });
});

describe("confidentialité des erreurs", () => {
  it("ne contient jamais la clé, le texte envoyé ni le corps de la réponse du fournisseur", async () => {
    const providerBody = JSON.stringify({ error: { message: `clé invalide : ${API_KEY}`, input: messages[0]!.content } });
    const { client } = clientWith(vi.fn().mockResolvedValue(new Response(providerBody, { status: 401 })));

    const error = await failureOf(client.chat({ messages, maxTokens: 100 }));

    const everything = `${error.message} ${JSON.stringify(error)} ${error.stack}`;
    expect(everything).not.toContain(API_KEY);
    expect(everything).not.toContain("imprimante");
    expect(error.message).toBe("Appel IA échoué (http, http 401)");
  });

  it("n'écrit rien dans la console", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method));
    const { client } = clientWith(vi.fn().mockResolvedValue(new Response("{}", { status: 500 })));

    await failureOf(client.chat({ messages, maxTokens: 100 }));

    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });
});

describe("client par défaut", () => {
  it("refuse d'appeler le vrai fournisseur pendant les tests", () => {
    setLlmClient(undefined);

    expect(() => getLlmClient()).toThrow(LlmError);
  });

  it("utilise le faux client installé par un test", async () => {
    const fake = { chat: vi.fn().mockResolvedValue({ content: "x", promptTokens: 1, completionTokens: 1 }) };
    setLlmClient(fake);

    expect(getLlmClient()).toBe(fake);
    setLlmClient(undefined);
  });
});

import { z } from "zod";

export const aiCategories = [
  "HARDWARE",
  "SOFTWARE",
  "NETWORK",
  "ACCOUNT_ACCESS",
  "EMAIL",
  "PRINTING",
  "SECURITY",
  "OTHER",
] as const;

export const aiPriorities = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;

// Sorties attendues de l'IA. Les champs inconnus sont ignorés (jamais lus) : ce qui compte pour la
// sécurité, c'est que chaque champ qu'on lit soit d'un type et d'une valeur stricts.
export const triageOutputSchema = z.object({
  inScope: z.boolean(),
  category: z.enum(aiCategories),
  priority: z.enum(aiPriorities),
  priorityReason: z.string().trim().min(1).max(200),
  confidence: z.number().min(0).max(1),
});

export const replyOutputSchema = z.object({
  reply: z.string().trim().min(1).max(2000),
  confidence: z.number().min(0).max(1),
  needsHuman: z.boolean(),
});

export type TriageOutput = z.infer<typeof triageOutputSchema>;
export type ReplyOutput = z.infer<typeof replyOutputSchema>;

export type ParsedOutput<T> = { ok: true; data: T } | { ok: false };

// Les modèles entourent parfois le JSON de ```json ... ``` malgré le mode JSON.
function stripCodeFence(text: string): string {
  const match = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1] ?? text.trim();
}

export function parseModelOutput<T>(content: string, schema: z.ZodType<T>): ParsedOutput<T> {
  let raw: unknown;

  try {
    raw = JSON.parse(stripCodeFence(content));
  } catch {
    return { ok: false };
  }

  const result = schema.safeParse(raw);
  return result.success ? { ok: true, data: result.data } : { ok: false };
}

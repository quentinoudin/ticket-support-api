import { z } from "zod";

export const emailSchema = z
  .string({ error: "L'email est obligatoire" })
  .trim()
  .toLowerCase()
  .pipe(z.email("L'email n'est pas valide"));

// Mots de passe les plus courants (français et anglais). On compare la base du mot de passe, sans les
// chiffres et symboles ajoutés à la fin : « Password1234 » et « Azerty123456 » sont refusés.
const COMMON_BASES = new Set([
  "password", "motdepasse", "azerty", "azertyuiop", "qwerty", "qwertyuiop", "bonjour", "soleil", "admin",
  "administrateur", "welcome", "bienvenue", "letmein", "iloveyou", "football", "marseille", "doudou", "chouchou",
  "abcdefgh", "abcdefghij", "changeme", "secret", "master", "dragon", "monkey", "login", "azertyazerty", "supportit",
]);

function isCommonPassword(password: string): boolean {
  const base = password.toLowerCase().replace(/[\d\W_]+/g, "");
  return COMMON_BASES.has(base) || /^(.)+$/.test(base);
}

// bcrypt ignore tout ce qui dépasse 72 octets : on plafonne pour éviter les surprises.
export const passwordSchema = z
  .string({ error: "Le mot de passe est obligatoire" })
  .min(12, "Le mot de passe doit faire 12 caractères minimum")
  .max(72, "Le mot de passe ne peut pas dépasser 72 caractères")
  .regex(/[A-Za-z]/, "Le mot de passe doit contenir au moins une lettre")
  .regex(/\d/, "Le mot de passe doit contenir au moins un chiffre")
  .refine((value) => !isCommonPassword(value), "Ce mot de passe est trop courant : choisissez-en un autre");

export const loginSchema = z
  .object({
    email: emailSchema,
    password: z.string({ error: "Le mot de passe est obligatoire" }).min(1, "Le mot de passe est obligatoire"),
  })
  .strict();

export const refreshTokenSchema = z
  .object({
    refreshToken: z.string({ error: "Le jeton de rafraîchissement est obligatoire" }).min(1),
  })
  .strict();

export const acceptInviteSchema = z
  .object({
    token: z.string({ error: "Le jeton est obligatoire" }).min(1, "Le jeton est obligatoire"),
    password: passwordSchema,
  })
  .strict();

export const forgotPasswordSchema = z.object({ email: emailSchema }).strict();

export const resetPasswordSchema = z
  .object({
    token: z.string({ error: "Le jeton est obligatoire" }).min(1, "Le jeton est obligatoire"),
    password: passwordSchema,
  })
  .strict();

export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;
export type LoginInput = z.infer<typeof loginSchema>;

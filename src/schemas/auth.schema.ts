import { z } from "zod";

export const emailSchema = z
  .string({ error: "L'email est obligatoire" })
  .trim()
  .toLowerCase()
  .pipe(z.email("L'email n'est pas valide"));

// bcrypt ignore tout ce qui dépasse 72 octets : on plafonne pour éviter les surprises.
export const passwordSchema = z
  .string({ error: "Le mot de passe est obligatoire" })
  .min(10, "Le mot de passe doit faire 10 caractères minimum")
  .max(72, "Le mot de passe ne peut pas dépasser 72 caractères")
  .regex(/[A-Za-z]/, "Le mot de passe doit contenir au moins une lettre")
  .regex(/\d/, "Le mot de passe doit contenir au moins un chiffre");

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

export type LoginInput = z.infer<typeof loginSchema>;

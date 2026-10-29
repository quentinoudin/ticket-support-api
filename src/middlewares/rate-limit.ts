import { rateLimit } from "express-rate-limit";

// Désactivé pendant les tests pour ne pas les rendre dépendants du nombre de requêtes.
const skip = () => process.env.NODE_ENV === "test";

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip,
  message: { error: "Trop de tentatives, réessayez plus tard" },
});

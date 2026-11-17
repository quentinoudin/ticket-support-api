import type { Request, RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";

import { AppError } from "../errors/app-error.js";

interface LimiterOptions {
  windowMs: number;
  limit: number;
  message?: string;
  // Désactivé par défaut pendant les tests, pour ne pas les rendre dépendants du nombre de requêtes.
  skip?: () => boolean;
  // Clé de comptage ; par défaut l'adresse IP.
  keyGenerator?: (request: Request) => string;
}

const MINUTE = 60 * 1000;
const skipInTest = () => process.env.NODE_ENV === "test";

export function createLimiter({
  windowMs,
  limit,
  message = "Trop de requêtes, réessayez plus tard",
  skip = skipInTest,
  keyGenerator,
}: LimiterOptions): RequestHandler {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip,
    ...(keyGenerator && { keyGenerator }),
    // Passe par le gestionnaire d'erreurs pour garder le format { error, code }.
    handler: (_request, _response, next) => next(new AppError(message, 429)),
  });
}

// Filet de sécurité sur toute l'API (par adresse IP).
export const globalLimiter = createLimiter({ windowMs: 15 * MINUTE, limit: 300 });

// Connexion : le plus surveillé, c'est la cible des attaques par force brute.
export const loginLimiter = createLimiter({
  windowMs: 15 * MINUTE,
  limit: 10,
  message: "Trop de tentatives de connexion, réessayez dans quelques minutes",
});

// Mot de passe oublié / réinitialisation : évite le spam d'emails et le devinage de jetons.
export const passwordResetLimiter = createLimiter({
  windowMs: 15 * MINUTE,
  limit: 5,
  message: "Trop de demandes de réinitialisation, réessayez plus tard",
});

// Messages des tickets : chaque message d'un utilisateur peut déclencher un appel à l'IA payant.
export const messageLimiter = createLimiter({
  windowMs: 15 * MINUTE,
  limit: 60,
  message: "Trop de messages envoyés, réessayez dans quelques minutes",
});

// Autres routes d'authentification (refresh, acceptation d'invitation).
export const authLimiter = createLimiter({ windowMs: 15 * MINUTE, limit: 20 });

// Création de tickets : chacun peut déclencher un appel payant à l'IA et occupe de la place en base.
// Comptage par utilisateur connecté (à placer après `authenticate`).
export const ticketCreateLimiter = createLimiter({
  windowMs: 15 * MINUTE,
  limit: 30,
  message: "Trop de tickets créés, réessayez dans quelques minutes",
  keyGenerator: (request) => request.user?.id ?? "anonyme",
});

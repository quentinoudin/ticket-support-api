import type { RequestHandler } from "express";

import { AppError } from "../errors/app-error.js";
import { prisma } from "../lib/prisma.js";
import { verifyAccessToken } from "../services/token.service.js";

// Recharge l'utilisateur à chaque requête : un compte désactivé perd l'accès immédiatement.
export const authenticate: RequestHandler = async (request, _response, next) => {
  const header = request.headers.authorization;

  if (!header?.startsWith("Bearer ")) {
    throw new AppError("Authentification requise", 401);
  }

  const payload = verifyAccessToken(header.slice("Bearer ".length));
  const user = await prisma.user.findUnique({ where: { id: payload.sub } });

  if (!user || user.status !== "ACTIVE") {
    throw new AppError("Authentification requise", 401);
  }

  request.user = { id: user.id, email: user.email, role: user.role };
  next();
};

import jwt, { type SignOptions } from "jsonwebtoken";

import { env } from "../config/env.js";
import { AppError } from "../errors/app-error.js";
import type { UserRole } from "../generated/prisma/client.js";

export interface AccessTokenPayload {
  sub: string;
  role: UserRole;
}

export function signAccessToken(user: { id: string; role: UserRole }): string {
  return jwt.sign({ role: user.role }, env.JWT_ACCESS_SECRET, {
    subject: user.id,
    expiresIn: env.JWT_ACCESS_TTL as SignOptions["expiresIn"],
    algorithm: "HS256",
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ["HS256"] });

    if (typeof payload === "string" || typeof payload.sub !== "string") {
      throw new Error("Payload invalide");
    }

    return { sub: payload.sub, role: payload.role as UserRole };
  } catch {
    throw new AppError("Jeton d'accès invalide ou expiré", 401);
  }
}

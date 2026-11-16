import type { RequestHandler } from "express";

import { hasRoleAtLeast } from "../auth/permissions.js";
import { AppError } from "../errors/app-error.js";
import type { UserRole } from "../generated/prisma/client.js";

// À placer après `authenticate`.
export function requireRole(minimum: UserRole): RequestHandler {
  return (request, _response, next) => {
    if (!request.user) {
      throw new AppError("Authentification requise", 401);
    }

    if (!hasRoleAtLeast(request.user.role, minimum)) {
      throw new AppError("Accès refusé", 403);
    }

    next();
  };
}

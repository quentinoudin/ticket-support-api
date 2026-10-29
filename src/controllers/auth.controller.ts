import type { Request, Response } from "express";

import { AppError } from "../errors/app-error.js";
import { prisma } from "../lib/prisma.js";
import { loginSchema } from "../schemas/auth.schema.js";
import * as authService from "../services/auth.service.js";

export async function login(request: Request, response: Response): Promise<void> {
  const input = loginSchema.parse(request.body);
  const result = await authService.login(input);
  response.status(200).json({ data: result });
}

export async function me(request: Request, response: Response): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: request.user!.id } });

  if (!user) {
    throw new AppError("Authentification requise", 401);
  }

  response.status(200).json({
    data: { ...authService.toPublicUser(user), lastLoginAt: user.lastLoginAt, createdAt: user.createdAt },
  });
}

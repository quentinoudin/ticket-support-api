import type { Request, Response } from "express";

import { AppError } from "../errors/app-error.js";
import { prisma } from "../lib/prisma.js";
import {
  acceptInviteSchema,
  forgotPasswordSchema,
  loginSchema,
  refreshTokenSchema,
  resetPasswordSchema,
} from "../schemas/auth.schema.js";
import * as authService from "../services/auth.service.js";

export async function login(request: Request, response: Response): Promise<void> {
  const input = loginSchema.parse(request.body);
  const result = await authService.login(input);
  response.status(200).json({ data: result });
}

export async function acceptInvite(request: Request, response: Response): Promise<void> {
  const input = acceptInviteSchema.parse(request.body);
  response.status(200).json({ data: await authService.acceptInvite(input) });
}

export async function forgotPassword(request: Request, response: Response): Promise<void> {
  const input = forgotPasswordSchema.parse(request.body);
  await authService.forgotPassword(input);
  response.status(200).json({
    message: "Si un compte actif existe pour cet email, un lien de réinitialisation vient d'être envoyé.",
  });
}

export async function resetPassword(request: Request, response: Response): Promise<void> {
  const input = resetPasswordSchema.parse(request.body);
  await authService.resetPassword(input);
  response.status(204).send();
}

export async function refresh(request: Request, response: Response): Promise<void> {
  const { refreshToken } = refreshTokenSchema.parse(request.body);
  const result = await authService.refresh(refreshToken);
  response.status(200).json({ data: result });
}

export async function logout(request: Request, response: Response): Promise<void> {
  const { refreshToken } = refreshTokenSchema.parse(request.body);
  await authService.logout(refreshToken);
  response.status(204).send();
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

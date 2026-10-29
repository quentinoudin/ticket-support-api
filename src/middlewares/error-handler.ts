import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";

import { AppError } from "../errors/app-error.js";

export const notFoundHandler: RequestHandler = (request, _response, next) => {
  next(new AppError(`Route ${request.method} ${request.path} introuvable`, 404));
};

function isPrismaKnownRequestError(error: unknown): error is Error & { code: string } {
  return (
    error instanceof Error &&
    error.name === "PrismaClientKnownRequestError" &&
    "code" in error &&
    typeof error.code === "string"
  );
}

export const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  if (error instanceof ZodError) {
    response.status(400).json({
      error: "Données invalides",
      details: error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    });
    return;
  }

  if (error instanceof AppError) {
    response.status(error.statusCode).json({ error: error.message });
    return;
  }

  if (isPrismaKnownRequestError(error)) {
    if (error.code === "P2025") {
      response.status(404).json({ error: "Ticket introuvable" });
      return;
    }

    if (error.code === "P2002") {
      response.status(409).json({ error: "Cette ressource existe déjà" });
      return;
    }
  }

  if (error instanceof SyntaxError && "status" in error && error.status === 400) {
    response.status(400).json({ error: "Le corps JSON est invalide" });
    return;
  }

  console.error(error);
  response.status(500).json({ error: "Erreur interne du serveur" });
};
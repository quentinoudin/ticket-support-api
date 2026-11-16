import type { ErrorRequestHandler, RequestHandler, Response } from "express";
import { ZodError } from "zod";

import { AppError, type ErrorCode } from "../errors/app-error.js";

// Toutes les erreurs de l'API ont la même forme : { error, code, details? }.
export interface ErrorBody {
  error: string;
  code: ErrorCode;
  details?: { field: string; message: string }[];
}

function sendError(response: Response, status: number, body: ErrorBody) {
  response.status(status).json(body);
}

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

// Erreurs levées par le parseur JSON d'Express (body-parser).
function bodyParserType(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "type" in error && typeof error.type === "string"
    ? error.type
    : undefined;
}

export const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  if (error instanceof ZodError) {
    sendError(response, 400, {
      error: "Données invalides",
      code: "VALIDATION_ERROR",
      details: error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    });
    return;
  }

  if (error instanceof AppError) {
    sendError(response, error.statusCode, { error: error.message, code: error.code });
    return;
  }

  if (isPrismaKnownRequestError(error)) {
    if (error.code === "P2025") {
      sendError(response, 404, { error: "Ressource introuvable", code: "NOT_FOUND" });
      return;
    }

    if (error.code === "P2002") {
      sendError(response, 409, { error: "Cette ressource existe déjà", code: "CONFLICT" });
      return;
    }
  }

  const parserType = bodyParserType(error);

  if (parserType === "entity.too.large") {
    sendError(response, 413, { error: "Le corps de la requête est trop volumineux", code: "PAYLOAD_TOO_LARGE" });
    return;
  }

  if (parserType === "entity.parse.failed") {
    sendError(response, 400, { error: "Le corps JSON est invalide", code: "INVALID_JSON" });
    return;
  }

  // Dernier filet : un texte que PostgreSQL ne sait pas stocker est une erreur du client, pas du serveur.
  if (error instanceof Error && error.message.includes("invalid byte sequence for encoding")) {
    sendError(response, 400, { error: "Le texte contient un caractère interdit", code: "BAD_REQUEST" });
    return;
  }

  // Détail uniquement dans les logs serveur : jamais renvoyé au client.
  console.error(error);
  sendError(response, 500, { error: "Erreur interne du serveur", code: "INTERNAL_ERROR" });
};

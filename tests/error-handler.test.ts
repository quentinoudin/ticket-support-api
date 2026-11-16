import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { app } from "../src/app.js";
import { AppError } from "../src/errors/app-error.js";
import { errorHandler, notFoundHandler } from "../src/middlewares/error-handler.js";

afterEach(() => vi.restoreAllMocks());

// Mini application pour déclencher chaque type d'erreur de façon contrôlée.
function appThatThrows(error: unknown) {
  const testApp = express();
  testApp.use(express.json({ limit: "1kb" }));
  testApp.get("/boom", () => {
    throw error;
  });
  testApp.post("/echo", (_request, response) => {
    response.json({ ok: true });
  });
  testApp.use(notFoundHandler);
  testApp.use(errorHandler);
  return testApp;
}

describe("format unique des erreurs", () => {
  it("route inconnue : 404 NOT_FOUND", async () => {
    const response = await request(app).get("/n-existe-pas");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Route GET /n-existe-pas introuvable", code: "NOT_FOUND" });
  });

  it("erreur Zod : 400 VALIDATION_ERROR avec le détail par champ", async () => {
    const parsed = z.object({ title: z.string() }).safeParse({});
    const response = await request(appThatThrows(parsed.error)).get("/boom");

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("VALIDATION_ERROR");
    expect(response.body.details).toEqual([{ field: "title", message: expect.any(String) }]);
  });

  it.each([
    [401, "UNAUTHORIZED"],
    [403, "FORBIDDEN"],
    [404, "NOT_FOUND"],
    [409, "CONFLICT"],
    [429, "RATE_LIMITED"],
  ])("AppError %i : code %s déduit du statut", async (status, code) => {
    const response = await request(appThatThrows(new AppError("Message", status))).get("/boom");

    expect(response.status).toBe(status);
    expect(response.body).toEqual({ error: "Message", code });
  });

  it("JSON mal formé : 400 INVALID_JSON", async () => {
    const response = await request(appThatThrows(new Error("x")))
      .post("/echo")
      .set("Content-Type", "application/json")
      .send("{bad");

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "Le corps JSON est invalide", code: "INVALID_JSON" });
  });

  it("corps trop volumineux : 413 PAYLOAD_TOO_LARGE", async () => {
    const response = await request(appThatThrows(new Error("x")))
      .post("/echo")
      .send({ data: "x".repeat(5000) });

    expect(response.status).toBe(413);
    expect(response.body.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("erreur inattendue : 500 sans jamais exposer le détail", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await request(appThatThrows(new Error("mot de passe de la base : secret"))).get("/boom");

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Erreur interne du serveur", code: "INTERNAL_ERROR" });
    expect(JSON.stringify(response.body)).not.toContain("secret");
    expect(log).toHaveBeenCalled();
  });

  it("limite de taille de l'API réelle : 413 au-delà de 100 ko", async () => {
    const response = await request(app)
      .post("/tickets")
      .send({ title: "x", description: "x".repeat(150_000) });

    expect(response.status).toBe(413);
  });
});

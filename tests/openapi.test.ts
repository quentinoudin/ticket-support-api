import SwaggerParser from "@apidevtools/swagger-parser";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { app } from "../src/app.js";
import { buildOpenApiDocument } from "../src/docs/openapi.js";

// Liste de référence : si une route est ajoutée sans être documentée, ce test doit être mis à jour.
const documentedOperations = [
  "get /health",
  "post /auth/login",
  "post /auth/refresh",
  "post /auth/logout",
  "get /auth/me",
  "post /auth/accept-invite",
  "post /auth/forgot-password",
  "post /auth/reset-password",
  "post /users",
  "get /users",
  "get /users/super-admin",
  "get /users/{id}",
  "patch /users/{id}",
  "delete /users/{id}",
  "post /users/{id}/disable",
  "post /users/{id}/enable",
  "post /users/{id}/resend-invite",
  "post /tickets",
  "get /tickets",
  "get /tickets/{id}",
  "put /tickets/{id}",
  "patch /tickets/{id}",
  "delete /tickets/{id}",
  "get /tickets/{id}/messages",
  "post /tickets/{id}/messages",
  "post /tickets/{id}/feedback",
  "get /audit-logs",
];

describe("documentation OpenAPI", () => {
  it("est une spécification OpenAPI 3 valide", async () => {
    const document = structuredClone(buildOpenApiDocument());

    await expect(SwaggerParser.validate(document as never)).resolves.toBeDefined();
  });

  it("documente toutes les routes de l'API, et seulement celles-là", () => {
    const { paths } = buildOpenApiDocument();
    const operations = Object.entries(paths).flatMap(([path, methods]) =>
      Object.keys(methods).map((method) => `${method} ${path}`),
    );

    expect(operations.sort()).toEqual([...documentedOperations].sort());
  });

  it("reprend les règles de validation Zod (champs obligatoires, limites et valeurs permises)", () => {
    const { paths } = buildOpenApiDocument();
    const createTicket = (paths["/tickets"].post as any).requestBody.content["application/json"].schema;

    expect(createTicket.required).toEqual(expect.arrayContaining(["title", "description"]));
    expect(createTicket.properties.title.maxLength).toBe(200);
    expect(createTicket.properties.status.enum).toEqual(["OPEN", "IN_PROGRESS", "CLOSED"]);
    expect(createTicket.additionalProperties).toBe(false);
  });

  it("décrit les paramètres de liste, dont le tri, avec leurs valeurs par défaut", () => {
    const { paths } = buildOpenApiDocument();
    const parameters = (paths["/tickets"].get as any).parameters as { name: string; schema: any }[];
    const byName = Object.fromEntries(parameters.map((p) => [p.name, p.schema]));

    expect(Object.keys(byName)).toEqual(
      expect.arrayContaining(["page", "limit", "status", "priority", "sortBy", "order"]),
    );
    expect(byName.limit.maximum).toBe(100);
    expect(byName.sortBy.enum).toContain("priority");
    expect(byName.order.default).toBe("desc");
  });

  it("marque les routes protégées par le jeton et laisse les autres publiques", () => {
    const { paths } = buildOpenApiDocument();

    expect((paths["/tickets"].get as any).security).toEqual([{ bearerAuth: [] }]);
    expect((paths["/auth/login"].post as any).security).toBeUndefined();
    expect((paths["/health"].get as any).security).toBeUndefined();
  });

  it("est servie en JSON sur /openapi.json et en page web sur /docs", async () => {
    const json = await request(app).get("/openapi.json");
    const docs = await request(app).get("/docs/").redirects(1);

    expect(json.status).toBe(200);
    expect(json.body.openapi).toBe("3.0.3");
    expect(docs.status).toBe(200);
    expect(docs.headers["content-type"]).toContain("text/html");
  });
});

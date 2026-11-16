import { z } from "zod";

import { auditActions } from "../audit/actions.js";
import { env } from "../config/env.js";
import {
  acceptInviteSchema,
  forgotPasswordSchema,
  loginSchema,
  refreshTokenSchema,
  resetPasswordSchema,
} from "../schemas/auth.schema.js";
import { listAuditLogsSchema } from "../schemas/audit.schema.js";
import {
  createTicketSchema,
  listTicketsSchema,
  replaceTicketSchema,
  updateTicketSchema,
} from "../schemas/ticket.schema.js";
import { createUserSchema, listUsersSchema, updateUserSchema } from "../schemas/user.schema.js";

type JsonSchema = Record<string, unknown>;

// Les schémas de requête viennent directement de Zod : la documentation suit donc la validation.
function toSchema(schema: z.ZodType): JsonSchema {
  const json = z.toJSONSchema(schema, {
    target: "openapi-3.0",
    io: "input",
    unrepresentable: "any",
    override: ({ zodSchema, jsonSchema }) => {
      if (zodSchema._zod.def.type === "date") {
        jsonSchema.type = "string";
        jsonSchema.format = "date-time";
      }
    },
  }) as JsonSchema;

  return stripSafeIntegerBounds(json);
}

// Zod ajoute les bornes des entiers sûrs de JavaScript : du bruit inutile dans la documentation.
function stripSafeIntegerBounds(node: JsonSchema): JsonSchema {
  const clean = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(clean);
    }

    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as JsonSchema)
          .filter(([key, v]) => !((key === "minimum" && v === -9007199254740991) || (key === "maximum" && v === 9007199254740991)))
          .map(([key, v]) => [key, clean(v)]),
      );
    }

    return value;
  };

  return clean(node) as JsonSchema;
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const jsonContent = (schema: JsonSchema) => ({ "application/json": { schema } });

const requestBody = (schema: z.ZodType) => ({ required: true, content: jsonContent(toSchema(schema)) });

function queryParameters(schema: z.ZodType) {
  const json = toSchema(schema) as { properties?: Record<string, JsonSchema>; required?: string[] };

  return Object.entries(json.properties ?? {}).map(([name, propertySchema]) => ({
    name,
    in: "query",
    required: json.required?.includes(name) ?? false,
    schema: propertySchema,
  }));
}

const idParameter = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
};

const errorDescriptions: Record<number, string> = {
  400: "Données invalides ou lien invalide/expiré",
  401: "Jeton absent, invalide ou expiré, ou identifiants incorrects",
  403: "Rôle insuffisant ou compte désactivé",
  404: "Ressource introuvable (ou hors de votre portée)",
  409: "Conflit (par exemple email déjà utilisé)",
  413: "Corps de requête trop volumineux",
  429: "Trop de requêtes ou compte temporairement verrouillé",
  500: "Erreur interne",
};

interface OperationOptions {
  tag: string;
  summary: string;
  description?: string;
  secured?: boolean;
  parameters?: unknown[];
  body?: z.ZodType;
  success: { status: number; description: string; schema?: JsonSchema };
  errors?: number[];
}

function operation(options: OperationOptions) {
  const { tag, summary, description, secured = true, parameters, body, success, errors = [] } = options;

  const responses: Record<string, unknown> = {
    [success.status]: {
      description: success.description,
      ...(success.schema && { content: jsonContent(success.schema) }),
    },
  };

  for (const status of [...errors, ...(secured ? [401] : []), 500]) {
    responses[status] = {
      description: errorDescriptions[status],
      content: jsonContent(ref("Error")),
    };
  }

  return {
    tags: [tag],
    summary,
    ...(description && { description }),
    ...(secured && { security: [{ bearerAuth: [] }] }),
    ...(parameters && { parameters }),
    ...(body && { requestBody: requestBody(body) }),
    responses,
  };
}

const paginated = (itemSchema: JsonSchema) => ({
  type: "object",
  properties: { data: { type: "array", items: itemSchema }, pagination: ref("Pagination") },
  required: ["data", "pagination"],
});

const data = (schema: JsonSchema) => ({
  type: "object",
  properties: { data: schema },
  required: ["data"],
});

export function buildOpenApiDocument() {
  return {
    openapi: "3.0.3",
    info: {
      title: "API de tickets de support",
      version: "1.0.0",
      description: [
        "API REST de gestion de tickets de support, avec authentification, rôles et invitation par email.",
        "",
        "**S'authentifier :** `POST /auth/login`, puis cliquez sur *Authorize* et collez l'`accessToken` (sans le mot « Bearer »). Le jeton expire au bout de 15 minutes : renouvelez-le avec `POST /auth/refresh`.",
        "",
        "**Rôles :** `SUPER_ADMIN` > `ADMIN` > `AGENT` > `USER`. Un compte hors de votre portée répond `404`.",
        "",
        "**Erreurs :** toutes les erreurs ont la forme `{ error, code, details? }`.",
      ].join("\n"),
    },
    servers: [{ url: env.APP_URL }],
    tags: [
      { name: "Santé" },
      { name: "Authentification", description: "Connexion, jetons, invitation et mot de passe oublié" },
      { name: "Comptes", description: "Gestion des utilisateurs (Admin et Super Admin)" },
      { name: "Tickets" },
      { name: "Audit", description: "Journal des actions sensibles (Super Admin)" },
    ],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      },
      schemas: {
        Error: {
          type: "object",
          properties: {
            error: { type: "string", example: "Données invalides" },
            code: {
              type: "string",
              enum: [
                "BAD_REQUEST",
                "VALIDATION_ERROR",
                "INVALID_JSON",
                "UNAUTHORIZED",
                "FORBIDDEN",
                "NOT_FOUND",
                "CONFLICT",
                "PAYLOAD_TOO_LARGE",
                "RATE_LIMITED",
                "INTERNAL_ERROR",
                "SERVICE_UNAVAILABLE",
              ],
            },
            details: {
              type: "array",
              description: "Présent pour VALIDATION_ERROR : une entrée par champ en cause.",
              items: {
                type: "object",
                properties: { field: { type: "string" }, message: { type: "string" } },
              },
            },
          },
          required: ["error", "code"],
        },
        Pagination: {
          type: "object",
          properties: {
            page: { type: "integer" },
            limit: { type: "integer" },
            total: { type: "integer" },
            totalPages: { type: "integer" },
          },
        },
        Ticket: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            title: { type: "string", maxLength: 200 },
            description: { type: "string" },
            status: { type: "string", enum: ["OPEN", "IN_PROGRESS", "CLOSED"] },
            priority: { type: "string", enum: ["LOW", "MEDIUM", "HIGH", "URGENT"] },
            createdById: { type: "string", format: "uuid", nullable: true },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        PublicUser: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            email: { type: "string", format: "email" },
            role: { type: "string", enum: ["SUPER_ADMIN", "ADMIN", "AGENT", "USER"] },
            status: { type: "string", enum: ["INVITED", "ACTIVE", "DISABLED"] },
          },
        },
        User: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            email: { type: "string", format: "email" },
            role: { type: "string", enum: ["SUPER_ADMIN", "ADMIN", "AGENT", "USER"] },
            status: { type: "string", enum: ["INVITED", "ACTIVE", "DISABLED"] },
            createdById: { type: "string", format: "uuid", nullable: true },
            lastLoginAt: { type: "string", format: "date-time", nullable: true },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        AuditLog: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            action: { type: "string", enum: [...auditActions] },
            actorId: { type: "string", format: "uuid", nullable: true },
            actorEmail: { type: "string", nullable: true },
            targetType: { type: "string", enum: ["User", "Ticket"], nullable: true },
            targetId: { type: "string", format: "uuid", nullable: true },
            metadata: { type: "object", nullable: true, additionalProperties: true },
            ip: { type: "string", nullable: true },
            userAgent: { type: "string", nullable: true },
            createdAt: { type: "string", format: "date-time" },
          },
        },
        Tokens: {
          type: "object",
          properties: { accessToken: { type: "string" }, refreshToken: { type: "string" } },
        },
      },
    },
    paths: {
      "/health": {
        get: operation({
          tag: "Santé",
          summary: "Vérifie l'API et la connexion à PostgreSQL",
          secured: false,
          success: {
            status: 200,
            description: "Tout fonctionne",
            schema: {
              type: "object",
              properties: { status: { type: "string", example: "ok" }, database: { type: "string", example: "connected" } },
            },
          },
          errors: [],
        }),
      },

      "/auth/login": {
        post: operation({
          tag: "Authentification",
          summary: "Se connecter avec un email et un mot de passe",
          description: "Après plusieurs échecs consécutifs, le compte est verrouillé temporairement (429).",
          secured: false,
          body: loginSchema,
          success: {
            status: 200,
            description: "Connexion réussie",
            schema: data({
              type: "object",
              properties: {
                accessToken: { type: "string" },
                refreshToken: { type: "string" },
                user: ref("PublicUser"),
              },
            }),
          },
          errors: [400, 403, 429],
        }),
      },
      "/auth/refresh": {
        post: operation({
          tag: "Authentification",
          summary: "Renouveler les jetons",
          description:
            "Le refresh token est à usage unique : chaque appel en renvoie un nouveau. Rejouer un ancien jeton révoque toute la session.",
          secured: false,
          body: refreshTokenSchema,
          success: { status: 200, description: "Nouveaux jetons", schema: data(ref("Tokens")) },
          errors: [400, 401, 429],
        }),
      },
      "/auth/logout": {
        post: operation({
          tag: "Authentification",
          summary: "Se déconnecter (révoque le refresh token)",
          secured: false,
          body: refreshTokenSchema,
          success: { status: 204, description: "Déconnecté (idempotent)" },
          errors: [400],
        }),
      },
      "/auth/me": {
        get: operation({
          tag: "Authentification",
          summary: "Profil du compte connecté",
          success: { status: 200, description: "Profil", schema: data(ref("PublicUser")) },
        }),
      },
      "/auth/accept-invite": {
        post: operation({
          tag: "Authentification",
          summary: "Accepter une invitation et choisir son mot de passe",
          description: "Le jeton vient de l'email d'invitation. Il est à usage unique et valable 48 heures.",
          secured: false,
          body: acceptInviteSchema,
          success: { status: 200, description: "Compte activé", schema: data(ref("PublicUser")) },
          errors: [400, 429],
        }),
      },
      "/auth/forgot-password": {
        post: operation({
          tag: "Authentification",
          summary: "Demander un lien de réinitialisation",
          description: "La réponse est toujours la même, que l'email existe ou non.",
          secured: false,
          body: forgotPasswordSchema,
          success: {
            status: 200,
            description: "Demande prise en compte",
            schema: { type: "object", properties: { message: { type: "string" } } },
          },
          errors: [400, 429],
        }),
      },
      "/auth/reset-password": {
        post: operation({
          tag: "Authentification",
          summary: "Choisir un nouveau mot de passe avec le jeton reçu par email",
          description: "Le jeton est à usage unique et valable 60 minutes. Toutes les sessions ouvertes sont révoquées.",
          secured: false,
          body: resetPasswordSchema,
          success: { status: 204, description: "Mot de passe changé" },
          errors: [400, 429],
        }),
      },

      "/users": {
        post: operation({
          tag: "Comptes",
          summary: "Inviter un utilisateur",
          description:
            "Crée un compte INVITED et envoie un email avec un lien à usage unique. Un Admin ne peut inviter que des AGENT et des USER. `emailSent` vaut false si l'email n'est pas parti : utilisez *resend-invite*.",
          body: createUserSchema,
          success: {
            status: 201,
            description: "Compte créé",
            schema: {
              type: "object",
              properties: { data: ref("User"), emailSent: { type: "boolean" } },
            },
          },
          errors: [400, 403, 409, 429],
        }),
        get: operation({
          tag: "Comptes",
          summary: "Lister les comptes",
          description: "Le compte Super Admin n'apparaît jamais ici.",
          parameters: queryParameters(listUsersSchema),
          success: { status: 200, description: "Liste paginée", schema: paginated(ref("User")) },
          errors: [400, 403],
        }),
      },
      "/users/super-admin": {
        get: operation({
          tag: "Comptes",
          summary: "Voir le compte Super Admin",
          description: "Réservé au Super Admin.",
          success: { status: 200, description: "Le compte Super Admin", schema: data(ref("User")) },
          errors: [403, 404],
        }),
      },
      "/users/{id}": {
        get: operation({
          tag: "Comptes",
          summary: "Détail d'un compte",
          parameters: [idParameter],
          success: { status: 200, description: "Le compte", schema: data(ref("User")) },
          errors: [400, 403, 404],
        }),
        patch: operation({
          tag: "Comptes",
          summary: "Modifier l'email ou le rôle d'un compte",
          description: "Un changement de rôle est enregistré dans le journal d'audit.",
          parameters: [idParameter],
          body: updateUserSchema,
          success: { status: 200, description: "Compte modifié", schema: data(ref("User")) },
          errors: [400, 403, 404, 409],
        }),
        delete: operation({
          tag: "Comptes",
          summary: "Supprimer un compte",
          description: "Réservé au Super Admin. Les tickets du compte sont conservés.",
          parameters: [idParameter],
          success: { status: 204, description: "Compte supprimé" },
          errors: [400, 403, 404],
        }),
      },
      "/users/{id}/disable": {
        post: operation({
          tag: "Comptes",
          summary: "Désactiver un compte",
          description: "Coupe l'accès immédiatement et révoque les refresh tokens.",
          parameters: [idParameter],
          success: { status: 200, description: "Compte désactivé", schema: data(ref("User")) },
          errors: [400, 403, 404],
        }),
      },
      "/users/{id}/enable": {
        post: operation({
          tag: "Comptes",
          summary: "Réactiver un compte",
          parameters: [idParameter],
          success: { status: 200, description: "Compte réactivé", schema: data(ref("User")) },
          errors: [400, 403, 404],
        }),
      },
      "/users/{id}/resend-invite": {
        post: operation({
          tag: "Comptes",
          summary: "Renvoyer l'invitation",
          description: "Uniquement pour un compte encore INVITED. Le nouveau lien annule le précédent.",
          parameters: [idParameter],
          success: {
            status: 200,
            description: "Invitation renvoyée",
            schema: { type: "object", properties: { data: ref("User"), emailSent: { type: "boolean" } } },
          },
          errors: [400, 403, 404, 409],
        }),
      },

      "/tickets": {
        post: operation({
          tag: "Tickets",
          summary: "Créer un ticket",
          description: "L'auteur est le compte connecté. `status` vaut OPEN et `priority` vaut MEDIUM par défaut.",
          body: createTicketSchema,
          success: { status: 201, description: "Ticket créé", schema: data(ref("Ticket")) },
          errors: [400, 413],
        }),
        get: operation({
          tag: "Tickets",
          summary: "Lister les tickets",
          description: "Un USER ne voit que ses propres tickets. Les autres rôles voient tout.",
          parameters: queryParameters(listTicketsSchema),
          success: { status: 200, description: "Liste paginée", schema: paginated(ref("Ticket")) },
          errors: [400],
        }),
      },
      "/tickets/{id}": {
        get: operation({
          tag: "Tickets",
          summary: "Détail d'un ticket",
          parameters: [idParameter],
          success: { status: 200, description: "Le ticket", schema: data(ref("Ticket")) },
          errors: [400, 404],
        }),
        put: operation({
          tag: "Tickets",
          summary: "Remplacer tous les champs d'un ticket",
          description: "Réservé à AGENT et au-dessus. Les quatre champs sont obligatoires.",
          parameters: [idParameter],
          body: replaceTicketSchema,
          success: { status: 200, description: "Ticket remplacé", schema: data(ref("Ticket")) },
          errors: [400, 403, 404],
        }),
        patch: operation({
          tag: "Tickets",
          summary: "Modifier un ou plusieurs champs d'un ticket",
          description:
            "Un USER ne peut modifier que le titre et la description de ses propres tickets. Au moins un champ est obligatoire.",
          parameters: [idParameter],
          body: updateTicketSchema,
          success: { status: 200, description: "Ticket modifié", schema: data(ref("Ticket")) },
          errors: [400, 403, 404],
        }),
        delete: operation({
          tag: "Tickets",
          summary: "Supprimer un ticket",
          description: "Réservé à ADMIN et au-dessus.",
          parameters: [idParameter],
          success: { status: 204, description: "Ticket supprimé" },
          errors: [400, 403, 404],
        }),
      },

      "/audit-logs": {
        get: operation({
          tag: "Audit",
          summary: "Consulter le journal d'audit",
          description: "Réservé au Super Admin. Filtrable par action, acteur, cible et période.",
          parameters: queryParameters(listAuditLogsSchema),
          success: { status: 200, description: "Liste paginée", schema: paginated(ref("AuditLog")) },
          errors: [400, 403],
        }),
      },
    },
  };
}

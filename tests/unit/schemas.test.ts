import { describe, expect, it } from "vitest";

import { diffFields } from "../../src/services/audit.service.js";
import { escapeLikePattern } from "../../src/services/user.service.js";
import { emailSchema, passwordSchema } from "../../src/schemas/auth.schema.js";
import { listAuditLogsSchema } from "../../src/schemas/audit.schema.js";
import {
  createTicketSchema,
  listTicketsSchema,
  replaceTicketSchema,
  ticketIdSchema,
  updateTicketSchema,
} from "../../src/schemas/ticket.schema.js";
import { createUserSchema, listUsersSchema, updateUserSchema } from "../../src/schemas/user.schema.js";

describe("emailSchema", () => {
  it("retire les espaces et passe en minuscules", () => {
    expect(emailSchema.parse("  Agent@Test.LOCAL ")).toBe("agent@test.local");
  });

  it.each(["", "agent", "agent@", "@test.local", "a b@test.local"])("refuse %j", (value) => {
    expect(emailSchema.safeParse(value).success).toBe(false);
  });

  it("refuse tout ce qui n'est pas du texte", () => {
    for (const value of [undefined, null, 42, {}, ["a@b.co"]]) {
      expect(emailSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("passwordSchema", () => {
  it("accepte un mot de passe de 10 à 72 caractères avec une lettre et un chiffre", () => {
    expect(passwordSchema.safeParse("Motdepasse1").success).toBe(true);
    expect(passwordSchema.safeParse("a1".repeat(36)).success).toBe(true);
  });

  it.each([
    ["trop court", "Court1abc"],
    ["sans chiffre", "MotDePasseSansChiffre"],
    ["sans lettre", "1234567890123"],
    ["trop long (bcrypt tronque au-delà de 72)", "a1".repeat(37)],
  ])("refuse un mot de passe %s", (_label, value) => {
    expect(passwordSchema.safeParse(value).success).toBe(false);
  });
});

describe("schémas de ticket", () => {
  it("applique OPEN et MEDIUM par défaut à la création", () => {
    expect(createTicketSchema.parse({ title: "T", description: "D" })).toEqual({
      title: "T",
      description: "D",
      status: "OPEN",
      priority: "MEDIUM",
    });
  });

  it("limite le titre à 200 caractères et retire les espaces autour", () => {
    expect(createTicketSchema.parse({ title: "  T  ", description: " D " })).toMatchObject({ title: "T", description: "D" });
    expect(createTicketSchema.safeParse({ title: "x".repeat(200), description: "D" }).success).toBe(true);
    expect(createTicketSchema.safeParse({ title: "x".repeat(201), description: "D" }).success).toBe(false);
    expect(createTicketSchema.safeParse({ title: "   ", description: "D" }).success).toBe(false);
  });

  it("refuse les champs inconnus (mass assignment) et les mauvais types", () => {
    expect(createTicketSchema.safeParse({ title: "T", description: "D", createdById: "x" }).success).toBe(false);
    expect(createTicketSchema.safeParse({ title: ["T"], description: "D" }).success).toBe(false);
    expect(createTicketSchema.safeParse({ title: { $ne: null }, description: "D" }).success).toBe(false);
    expect(createTicketSchema.safeParse({ title: "T", description: "D", status: "DONE" }).success).toBe(false);
  });

  it("PUT exige les quatre champs, PATCH au moins un", () => {
    expect(replaceTicketSchema.safeParse({ title: "T", description: "D" }).success).toBe(false);
    expect(replaceTicketSchema.safeParse({ title: "T", description: "D", status: "OPEN", priority: "LOW" }).success).toBe(true);
    expect(updateTicketSchema.safeParse({}).success).toBe(false);
    expect(updateTicketSchema.safeParse({ priority: "URGENT" }).success).toBe(true);
  });

  it("valide l'identifiant comme un UUID", () => {
    expect(ticketIdSchema.safeParse({ id: "00000000-0000-4000-8000-000000000000" }).success).toBe(true);
    for (const id of ["1", "1 OR 1=1", "'; DROP TABLE \"Ticket\"; --", "../../etc/passwd"]) {
      expect(ticketIdSchema.safeParse({ id }).success).toBe(false);
    }
  });

  it("transforme et borne les paramètres de liste", () => {
    expect(listTicketsSchema.parse({})).toEqual({ page: 1, limit: 10, sortBy: "createdAt", order: "desc" });
    expect(listTicketsSchema.parse({ page: "3", limit: "50" })).toMatchObject({ page: 3, limit: 50 });

    for (const query of [{ page: "0" }, { page: "-1" }, { page: "1.5" }, { limit: "101" }, { limit: "abc" }]) {
      expect(listTicketsSchema.safeParse(query).success).toBe(false);
    }
  });
});

describe("schémas de compte", () => {
  it("n'accepte que les rôles ADMIN, AGENT et USER à la création", () => {
    expect(createUserSchema.safeParse({ email: "a@b.co", role: "AGENT" }).success).toBe(true);
    expect(createUserSchema.safeParse({ email: "a@b.co", role: "SUPER_ADMIN" }).success).toBe(false);
  });

  it("refuse de modifier le statut ou le mot de passe via PATCH", () => {
    expect(updateUserSchema.safeParse({ status: "ACTIVE" }).success).toBe(false);
    expect(updateUserSchema.safeParse({ passwordHash: "x" }).success).toBe(false);
    expect(updateUserSchema.safeParse({}).success).toBe(false);
    expect(updateUserSchema.safeParse({ role: "USER" }).success).toBe(true);
  });

  it("n'autorise le tri que sur des champs publics", () => {
    expect(listUsersSchema.safeParse({ sortBy: "email" }).success).toBe(true);
    expect(listUsersSchema.safeParse({ sortBy: "passwordHash" }).success).toBe(false);
  });
});

describe("schéma du journal d'audit", () => {
  it("convertit les dates et refuse les valeurs invalides", () => {
    const parsed = listAuditLogsSchema.parse({ from: "2026-01-01T00:00:00Z" });

    expect(parsed.from).toBeInstanceOf(Date);
    expect(listAuditLogsSchema.safeParse({ from: "hier" }).success).toBe(false);
    expect(listAuditLogsSchema.safeParse({ action: "PIRATAGE" }).success).toBe(false);
  });
});

describe("escapeLikePattern", () => {
  it("échappe les jokers SQL et l'antislash", () => {
    expect(escapeLikePattern("50%")).toBe("50\\%");
    expect(escapeLikePattern("a_b")).toBe("a\\_b");
    expect(escapeLikePattern("a\\b")).toBe("a\\\\b");
    expect(escapeLikePattern("%_\\")).toBe("\\%\\_\\\\");
  });

  it("laisse intact un texte ordinaire", () => {
    expect(escapeLikePattern("agent@test.local")).toBe("agent@test.local");
  });
});

describe("caractère nul", () => {
  it("est refusé dans les textes libres", () => {
    expect(createTicketSchema.safeParse({ title: "a\u0000b", description: "D" }).success).toBe(false);
    expect(createTicketSchema.safeParse({ title: "T", description: "a\u0000b" }).success).toBe(false);
    expect(listUsersSchema.safeParse({ search: "a\u0000b" }).success).toBe(false);
  });
});

describe("diffFields", () => {
  it("ne garde que les champs modifiés", () => {
    const before = { role: "AGENT", email: "a@b.co", status: "ACTIVE" };
    const after = { role: "ADMIN", email: "a@b.co", status: "ACTIVE" };

    expect(diffFields(before, after, ["role", "email"])).toEqual({ role: { from: "AGENT", to: "ADMIN" } });
  });

  it("renvoie un objet vide quand rien ne change", () => {
    const same = { role: "AGENT" };

    expect(diffFields(same, { ...same }, ["role"])).toEqual({});
  });
});

import { describe, expect, it } from "vitest";

import { canManageRole, hasRoleAtLeast, manageableRoles } from "../../src/auth/permissions.js";

describe("hasRoleAtLeast", () => {
  it.each([
    ["SUPER_ADMIN", "USER", true],
    ["SUPER_ADMIN", "SUPER_ADMIN", true],
    ["ADMIN", "AGENT", true],
    ["AGENT", "AGENT", true],
    ["AGENT", "ADMIN", false],
    ["USER", "AGENT", false],
    ["USER", "USER", true],
  ] as const)("%s a au moins le rôle %s : %s", (role, minimum, expected) => {
    expect(hasRoleAtLeast(role, minimum)).toBe(expected);
  });
});

describe("manageableRoles", () => {
  it("le Super Admin gère les ADMIN, AGENT et USER, jamais un SUPER_ADMIN", () => {
    expect(manageableRoles("SUPER_ADMIN")).toEqual(["ADMIN", "AGENT", "USER"]);
  });

  it("un Admin gère seulement les AGENT et USER", () => {
    expect(manageableRoles("ADMIN")).toEqual(["AGENT", "USER"]);
  });

  it("un Agent et un User ne gèrent personne", () => {
    expect(manageableRoles("AGENT")).toEqual([]);
    expect(manageableRoles("USER")).toEqual([]);
  });
});

describe("canManageRole", () => {
  it("personne ne peut gérer un SUPER_ADMIN", () => {
    for (const actor of ["SUPER_ADMIN", "ADMIN", "AGENT", "USER"] as const) {
      expect(canManageRole(actor, "SUPER_ADMIN")).toBe(false);
    }
  });

  it("un Admin ne peut pas gérer un autre Admin", () => {
    expect(canManageRole("ADMIN", "ADMIN")).toBe(false);
    expect(canManageRole("SUPER_ADMIN", "ADMIN")).toBe(true);
  });
});

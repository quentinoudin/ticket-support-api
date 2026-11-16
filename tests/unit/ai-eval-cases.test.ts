import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { aiCategories, aiPriorities } from "../../src/ai/schemas.js";
import { containsForbiddenContent } from "../../src/ai/guards.js";

interface EvalCase {
  id: string;
  title: string;
  description: string;
  requestedPriority: string;
  expected: { inScope: boolean; priority?: string[]; category?: string };
}

const cases = JSON.parse(readFileSync(new URL("../../scripts/ai-eval-cases.json", import.meta.url), "utf8")) as EvalCase[];

describe("jeu de tickets d'évaluation de l'IA", () => {
  it("contient 30 cas aux identifiants uniques, dont 21 dans le périmètre et 9 hors sujet", () => {
    expect(cases).toHaveLength(30);
    expect(new Set(cases.map((c) => c.id)).size).toBe(30);
    expect(cases.filter((c) => c.expected.inScope)).toHaveLength(21);
    expect(cases.filter((c) => !c.expected.inScope)).toHaveLength(9);
  });

  it("respecte les limites des tickets réels (titre 200, description non vide)", () => {
    for (const testCase of cases) {
      expect(testCase.title.length, testCase.id).toBeGreaterThan(0);
      expect(testCase.title.length, testCase.id).toBeLessThanOrEqual(200);
      expect(testCase.description.trim().length, testCase.id).toBeGreaterThan(0);
      expect(aiPriorities, testCase.id).toContain(testCase.requestedPriority);
    }
  });

  it("n'attend une priorité et une catégorie que pour les tickets du périmètre, avec des valeurs valides", () => {
    for (const { id, expected } of cases) {
      if (expected.inScope) {
        expect(expected.priority?.length, id).toBeGreaterThan(0);
        for (const priority of expected.priority!) {
          expect(aiPriorities, id).toContain(priority);
        }
        expect(aiCategories, id).toContain(expected.category);
      } else {
        expect(expected.priority, id).toBeUndefined();
        expect(expected.category, id).toBeUndefined();
      }
    }
  });

  it("couvre toutes les catégories, des priorités variées et des tentatives d'injection", () => {
    const inScope = cases.filter((c) => c.expected.inScope);

    expect(new Set(inScope.map((c) => c.expected.category))).toEqual(new Set(aiCategories));
    expect(new Set(inScope.flatMap((c) => c.expected.priority!))).toEqual(new Set(aiPriorities));
    expect(cases.some((c) => /ignore/i.test(c.description) && !c.expected.inScope)).toBe(true);
    expect(cases.some((c) => /<\/ticket>/i.test(c.description) && c.expected.inScope)).toBe(true);
  });

  it("n'embarque ni lien, ni email, ni donnée personnelle réelle", () => {
    for (const testCase of cases) {
      expect(containsForbiddenContent(`${testCase.title} ${testCase.description}`), testCase.id).toBe(false);
    }
  });
});

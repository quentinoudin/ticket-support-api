// Évaluation MANUELLE de la qualité du triage sur un jeu de tickets étiquetés.
//
// Ce script appelle le vrai fournisseur d'IA avec la clé du .env : il consomme des jetons de
// la clé partagée. Il n'est jamais lancé par les tests ni par la CI, et il refuse de partir sans
// --confirm. Il n'écrit rien en base et n'affiche ni prompt ni clé.
//
//   npm run ai:eval -- --confirm            lance les 30 cas
//   npm run ai:eval -- --confirm --limit 5  lance seulement les 5 premiers

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { aiConfig } from "../src/ai/config.js";
import { getLlmClient } from "../src/ai/llm-client.js";
import { buildTriageMessages } from "../src/ai/prompts/triage.js";
import { PROMPT_VERSION } from "../src/ai/prompts/version.js";
import { parseModelOutput, triageOutputSchema } from "../src/ai/schemas.js";
import { env } from "../src/config/env.js";

interface EvalCase {
  id: string;
  title: string;
  description: string;
  requestedPriority: string;
  expected: { inScope: boolean; priority?: string[]; category?: string };
}

const PRIORITY_ORDER = ["LOW", "MEDIUM", "HIGH", "URGENT"];
const PAUSE_MS = 400;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const rank = (priority: string) => PRIORITY_ORDER.indexOf(priority);
const percent = (count: number, total: number) => (total === 0 ? "n/a" : `${Math.round((count / total) * 100)} %`);

async function main() {
  const args = process.argv.slice(2);
  const confirmed = args.includes("--confirm");
  const limitIndex = args.indexOf("--limit");
  const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : Infinity;

  const allCases = JSON.parse(readFileSync(join(process.cwd(), "scripts", "ai-eval-cases.json"), "utf8")) as EvalCase[];
  const cases = allCases.slice(0, Number.isFinite(limit) && limit > 0 ? limit : undefined);

  // Estimation haute : prompt d'environ 700 jetons + sortie plafonnée à maxTokensTriage.
  const estimatedTokens = cases.length * (700 + aiConfig.maxTokensTriage);

  console.log(`Évaluation du triage : ${cases.length} cas, modèle ${aiConfig.model}, prompts version ${PROMPT_VERSION}`);
  console.log(`Estimation : au plus ${estimatedTokens} jetons (budget quotidien configuré : ${aiConfig.dailyTokenBudget}).`);

  if (!confirmed) {
    console.log("\nAucun appel n'a été fait. Relancez avec --confirm pour envoyer ces tickets à l'IA.");
    return 0;
  }

  if (!env.DEEPSEEK_API_KEY) {
    console.error("DEEPSEEK_API_KEY n'est pas renseignée dans le .env.");
    return 1;
  }

  let inScopeCorrect = 0;
  let wronglyClosed = 0;
  let offTopicCaught = 0;
  let offTopicTotal = 0;
  let priorityExact = 0;
  let priorityClose = 0;
  let priorityTotal = 0;
  let categoryCorrect = 0;
  let categoryTotal = 0;
  let invalid = 0;
  let errors = 0;
  let tokens = 0;

  console.log("\nid    attendu      reçu         priorité          catégorie");

  for (const testCase of cases) {
    try {
      const result = await getLlmClient().chat({
        messages: buildTriageMessages({
          title: testCase.title,
          description: testCase.description,
          requestedPriority: testCase.requestedPriority,
        }),
        maxTokens: aiConfig.maxTokensTriage,
        json: true,
      });
      tokens += result.promptTokens + result.completionTokens;

      const parsed = parseModelOutput(result.content, triageOutputSchema);

      if (!parsed.ok) {
        invalid++;
        console.log(`${testCase.id}  sortie invalide`);
        continue;
      }

      const got = parsed.data;
      const expected = testCase.expected;
      const scopeOk = got.inScope === expected.inScope;
      inScopeCorrect += scopeOk ? 1 : 0;

      // Le pire cas : un vrai ticket que l'assistant fermerait par erreur.
      if (expected.inScope && !got.inScope && got.confidence >= aiConfig.offTopicMinConfidence) {
        wronglyClosed++;
      }

      if (!expected.inScope) {
        offTopicTotal++;
        offTopicCaught += !got.inScope ? 1 : 0;
      }

      let priorityNote = "-";
      let categoryNote = "-";

      if (expected.inScope && expected.priority) {
        priorityTotal++;
        const exact = expected.priority.includes(got.priority);
        const close = expected.priority.some((p) => Math.abs(rank(p) - rank(got.priority)) <= 1);
        priorityExact += exact ? 1 : 0;
        priorityClose += close ? 1 : 0;
        priorityNote = `${got.priority} ${exact ? "ok" : close ? "proche" : "écart"}`;
      }

      if (expected.inScope && expected.category) {
        categoryTotal++;
        categoryCorrect += got.category === expected.category ? 1 : 0;
        categoryNote = `${got.category}${got.category === expected.category ? "" : ` (attendu ${expected.category})`}`;
      }

      console.log(
        `${testCase.id}  ${expected.inScope ? "périmètre " : "hors sujet"}  ${got.inScope ? "périmètre " : "hors sujet"}  ${priorityNote.padEnd(16)}  ${categoryNote}${scopeOk ? "" : "   <- ERREUR de périmètre"}`,
      );
    } catch (error) {
      errors++;
      console.log(`${testCase.id}  erreur : ${error instanceof Error ? error.message : "inconnue"}`);
    }

    await sleep(PAUSE_MS);
  }

  console.log("\n--- Résultats ---");
  console.log(`Périmètre correct           : ${inScopeCorrect}/${cases.length} (${percent(inScopeCorrect, cases.length)})`);
  console.log(`Hors sujet détectés         : ${offTopicCaught}/${offTopicTotal} (${percent(offTopicCaught, offTopicTotal)})`);
  console.log(`Vrais tickets fermés à tort : ${wronglyClosed}   <- doit rester à 0`);
  console.log(`Priorité exacte / proche    : ${priorityExact} / ${priorityClose} sur ${priorityTotal}`);
  console.log(`Catégorie correcte          : ${categoryCorrect}/${categoryTotal} (${percent(categoryCorrect, categoryTotal)})`);
  console.log(`Sorties invalides / erreurs : ${invalid} / ${errors}`);
  console.log(`Jetons consommés            : ${tokens}`);

  return wronglyClosed > 0 || errors > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });

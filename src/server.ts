import "dotenv/config";

import { aiJobHandlers } from "./ai/ai.service.js";
import { aiConfig } from "./ai/config.js";
import { startAiWorker, stopAiWorker } from "./ai/worker.js";
import { app } from "./app.js";
import { prisma } from "./lib/prisma.js";

const port = Number(process.env.PORT ?? 3000);

const server = app.listen(port, () => {
  console.log(`API disponible sur http://localhost:${port}`);
});

// L'assistant IA ne démarre que s'il est activé : AI_ENABLED=false par défaut.
if (aiConfig.enabled) {
  startAiWorker(aiJobHandlers);
  console.log(`Assistant IA activé (modèle ${aiConfig.model}, budget ${aiConfig.dailyTokenBudget} jetons par jour)`);
}

async function shutdown() {
  server.close(async () => {
    await stopAiWorker();
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

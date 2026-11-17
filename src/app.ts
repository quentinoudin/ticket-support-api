import express from "express";
import helmet from "helmet";
import swaggerUi from "swagger-ui-express";

import { env } from "./config/env.js";
import { buildOpenApiDocument } from "./docs/openapi.js";
import { prisma } from "./lib/prisma.js";
import { requestContextMiddleware } from "./lib/request-context.js";
import { errorHandler, notFoundHandler } from "./middlewares/error-handler.js";
import { globalLimiter } from "./middlewares/rate-limit.js";
import { aiRouter } from "./routes/ai.routes.js";
import { auditRouter } from "./routes/audit.routes.js";
import { authRouter } from "./routes/auth.routes.js";
import { ticketRouter } from "./routes/ticket.routes.js";
import { userRouter } from "./routes/user.routes.js";

export const app = express();

// Sans proxy de confiance configuré, req.ip est l'adresse réelle de l'appelant.
app.set("trust proxy", env.TRUST_PROXY);
app.use(helmet());
app.use(requestContextMiddleware);
app.use(express.json({ limit: "100kb" }));

app.get("/health", async (_request, response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    response.status(200).json({ status: "ok", database: "connected" });
  } catch {
    response.status(503).json({ status: "error", database: "disconnected" });
  }
});

// Documentation, montée avant la limite globale : l'interface charge beaucoup de fichiers.
// Désactivée par défaut en production (DOCS_ENABLED=true pour la publier).
if (env.DOCS_ENABLED) {
  const openApiDocument = buildOpenApiDocument();
  app.get("/openapi.json", (_request, response) => {
    response.json(openApiDocument);
  });
  app.use(
    "/docs",
    swaggerUi.serve,
    swaggerUi.setup(openApiDocument, { customSiteTitle: "API de tickets de support", swaggerOptions: { persistAuthorization: true } }),
  );
}

app.use(globalLimiter);
app.use("/auth", authRouter);
app.use("/users", userRouter);
app.use("/audit-logs", auditRouter);
app.use("/ai", aiRouter);
app.use("/tickets", ticketRouter);
app.use(notFoundHandler);
app.use(errorHandler);
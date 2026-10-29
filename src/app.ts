import express from "express";

import { prisma } from "./lib/prisma.js";
import { errorHandler, notFoundHandler } from "./middlewares/error-handler.js";
import { ticketRouter } from "./routes/ticket.routes.js";

export const app = express();

app.use(express.json());

app.get("/health", async (_request, response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    response.status(200).json({ status: "ok", database: "connected" });
  } catch {
    response.status(503).json({ status: "error", database: "disconnected" });
  }
});

app.use("/tickets", ticketRouter);
app.use(notFoundHandler);
app.use(errorHandler);
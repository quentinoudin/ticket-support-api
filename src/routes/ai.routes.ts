import { Router } from "express";

import * as aiController from "../controllers/ai.controller.js";
import { authenticate } from "../middlewares/authenticate.js";
import { requireRole } from "../middlewares/authorize.js";

export const aiRouter = Router();

aiRouter.use(authenticate, requireRole("ADMIN"));

aiRouter.get("/status", aiController.status);

import { Router } from "express";

import * as auditController from "../controllers/audit.controller.js";
import { authenticate } from "../middlewares/authenticate.js";
import { requireRole } from "../middlewares/authorize.js";

export const auditRouter = Router();

// Le journal d'audit est réservé au Super Admin.
auditRouter.use(authenticate, requireRole("SUPER_ADMIN"));

auditRouter.get("/", auditController.list);

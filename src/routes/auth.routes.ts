import { Router } from "express";

import * as authController from "../controllers/auth.controller.js";
import { authenticate } from "../middlewares/authenticate.js";
import { authLimiter } from "../middlewares/rate-limit.js";

export const authRouter = Router();

authRouter.post("/login", authLimiter, authController.login);
authRouter.get("/me", authenticate, authController.me);

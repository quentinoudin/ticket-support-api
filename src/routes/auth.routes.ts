import { Router } from "express";

import * as authController from "../controllers/auth.controller.js";
import { authenticate } from "../middlewares/authenticate.js";
import { authLimiter } from "../middlewares/rate-limit.js";

export const authRouter = Router();

authRouter.post("/login", authLimiter, authController.login);
authRouter.post("/accept-invite", authLimiter, authController.acceptInvite);
authRouter.post("/refresh", authLimiter, authController.refresh);
authRouter.post("/logout", authController.logout);
authRouter.get("/me", authenticate, authController.me);

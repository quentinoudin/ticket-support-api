import { Router } from "express";

import * as authController from "../controllers/auth.controller.js";
import { authenticate } from "../middlewares/authenticate.js";
import { authLimiter, loginLimiter, passwordResetLimiter } from "../middlewares/rate-limit.js";

export const authRouter = Router();

authRouter.post("/login", loginLimiter, authController.login);
authRouter.post("/accept-invite", authLimiter, authController.acceptInvite);
authRouter.post("/forgot-password", passwordResetLimiter, authController.forgotPassword);
authRouter.post("/reset-password", passwordResetLimiter, authController.resetPassword);
authRouter.post("/refresh", authLimiter, authController.refresh);
authRouter.post("/logout", authController.logout);
authRouter.get("/me", authenticate, authController.me);

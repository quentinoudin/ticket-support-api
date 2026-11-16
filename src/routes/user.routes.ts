import { Router } from "express";

import * as userController from "../controllers/user.controller.js";
import { authenticate } from "../middlewares/authenticate.js";
import { requireRole } from "../middlewares/authorize.js";

export const userRouter = Router();

userRouter.use(authenticate, requireRole("ADMIN"));

userRouter.post("/", userController.create);
userRouter.get("/", userController.list);
// Doit rester avant "/:id". Seul le Super Admin peut voir son propre compte.
userRouter.get("/super-admin", requireRole("SUPER_ADMIN"), userController.getSuperAdmin);
userRouter.get("/:id", userController.getById);
userRouter.patch("/:id", userController.update);
userRouter.post("/:id/resend-invite", userController.resendInvite);
userRouter.post("/:id/disable", userController.disable);
userRouter.post("/:id/enable", userController.enable);
userRouter.delete("/:id", requireRole("SUPER_ADMIN"), userController.remove);

import { Router } from "express";

import * as ticketController from "../controllers/ticket.controller.js";
import { authenticate } from "../middlewares/authenticate.js";
import { requireRole } from "../middlewares/authorize.js";

export const ticketRouter = Router();

ticketRouter.use(authenticate);

ticketRouter.post("/", ticketController.create);
ticketRouter.get("/", ticketController.list);
ticketRouter.get("/:id", ticketController.getById);
ticketRouter.put("/:id", requireRole("AGENT"), ticketController.replace);
ticketRouter.patch("/:id", ticketController.update);
ticketRouter.delete("/:id", requireRole("ADMIN"), ticketController.remove);

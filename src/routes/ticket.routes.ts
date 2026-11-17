import { Router } from "express";

import * as messageController from "../controllers/message.controller.js";
import * as ticketController from "../controllers/ticket.controller.js";
import { authenticate } from "../middlewares/authenticate.js";
import { requireRole } from "../middlewares/authorize.js";
import { messageLimiter, ticketCreateLimiter } from "../middlewares/rate-limit.js";

export const ticketRouter = Router();

ticketRouter.use(authenticate);

ticketRouter.post("/", ticketCreateLimiter, ticketController.create);
ticketRouter.get("/", ticketController.list);
ticketRouter.get("/:id", ticketController.getById);
ticketRouter.put("/:id", requireRole("AGENT"), ticketController.replace);
ticketRouter.patch("/:id", ticketController.update);
ticketRouter.delete("/:id", requireRole("ADMIN"), ticketController.remove);

ticketRouter.get("/:id/messages", messageController.list);
ticketRouter.post("/:id/messages", messageLimiter, messageController.create);
ticketRouter.post("/:id/feedback", messageLimiter, messageController.feedback);

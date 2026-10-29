import { Router } from "express";

import * as ticketController from "../controllers/ticket.controller.js";

export const ticketRouter = Router();

ticketRouter.post("/", ticketController.create);
ticketRouter.get("/", ticketController.list);
ticketRouter.get("/:id", ticketController.getById);
ticketRouter.put("/:id", ticketController.replace);
ticketRouter.patch("/:id", ticketController.update);
ticketRouter.delete("/:id", ticketController.remove);
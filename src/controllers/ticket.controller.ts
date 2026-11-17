import type { Request, Response } from "express";

import {
  createTicketSchema,
  listTicketsSchema,
  replaceTicketSchema,
  ticketIdSchema,
  updateTicketSchema,
} from "../schemas/ticket.schema.js";
import * as ticketService from "../services/ticket.service.js";
import { presentTicket } from "../services/ticket-view.js";

export async function create(request: Request, response: Response): Promise<void> {
  const data = createTicketSchema.parse(request.body);
  const ticket = await ticketService.createTicket(request.user!, data);
  response.status(201).json({ data: presentTicket(ticket, request.user!.role) });
}

export async function list(request: Request, response: Response): Promise<void> {
  const filters = listTicketsSchema.parse(request.query);
  const { tickets, total } = await ticketService.listTickets(request.user!, filters);

  response.status(200).json({
    data: tickets.map((ticket) => presentTicket(ticket, request.user!.role)),
    pagination: {
      page: filters.page,
      limit: filters.limit,
      total,
      totalPages: Math.ceil(total / filters.limit),
    },
  });
}

export async function getById(request: Request, response: Response): Promise<void> {
  const { id } = ticketIdSchema.parse(request.params);
  const ticket = await ticketService.getTicketById(request.user!, id);
  response.status(200).json({ data: presentTicket(ticket, request.user!.role) });
}

export async function replace(request: Request, response: Response): Promise<void> {
  const { id } = ticketIdSchema.parse(request.params);
  const data = replaceTicketSchema.parse(request.body);
  const ticket = await ticketService.replaceTicket(id, data);
  response.status(200).json({ data: ticket });
}

export async function update(request: Request, response: Response): Promise<void> {
  const { id } = ticketIdSchema.parse(request.params);
  const data = updateTicketSchema.parse(request.body);
  const ticket = await ticketService.updateTicket(request.user!, id, data);
  response.status(200).json({ data: presentTicket(ticket, request.user!.role) });
}

export async function remove(request: Request, response: Response): Promise<void> {
  const { id } = ticketIdSchema.parse(request.params);
  await ticketService.deleteTicket(id);
  response.status(204).send();
}
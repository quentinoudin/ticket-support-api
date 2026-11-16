import type { Request, Response } from "express";

import { createMessageSchema, feedbackSchema, listMessagesSchema } from "../schemas/message.schema.js";
import { ticketIdSchema } from "../schemas/ticket.schema.js";
import * as feedbackService from "../services/feedback.service.js";
import * as messageService from "../services/message.service.js";

export async function create(request: Request, response: Response): Promise<void> {
  const { id } = ticketIdSchema.parse(request.params);
  const input = createMessageSchema.parse(request.body);
  const { message } = await messageService.createMessage(request.user!, id, input);

  response.status(201).json({ data: message });
}

export async function feedback(request: Request, response: Response): Promise<void> {
  const { id } = ticketIdSchema.parse(request.params);
  const input = feedbackSchema.parse(request.body);
  const ticket = await feedbackService.submitFeedback(request.user!, id, input);

  response.status(200).json({ data: ticket });
}

export async function list(request: Request, response: Response): Promise<void> {
  const { id } = ticketIdSchema.parse(request.params);
  const filters = listMessagesSchema.parse(request.query);
  const { messages, total } = await messageService.listMessages(request.user!, id, filters);

  response.status(200).json({
    data: messages,
    pagination: {
      page: filters.page,
      limit: filters.limit,
      total,
      totalPages: Math.ceil(total / filters.limit),
    },
  });
}

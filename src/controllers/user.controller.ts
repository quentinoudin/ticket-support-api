import type { Request, Response } from "express";

import { createUserSchema, listUsersSchema, updateUserSchema, userIdSchema } from "../schemas/user.schema.js";
import * as userService from "../services/user.service.js";

export async function list(request: Request, response: Response): Promise<void> {
  const filters = listUsersSchema.parse(request.query);
  const { users, total } = await userService.listUsers(request.user!, filters);

  response.status(200).json({
    data: users,
    pagination: {
      page: filters.page,
      limit: filters.limit,
      total,
      totalPages: Math.ceil(total / filters.limit),
    },
  });
}

export async function create(request: Request, response: Response): Promise<void> {
  const input = createUserSchema.parse(request.body);
  const { user, emailSent } = await userService.createUser(request.user!, input);
  response.status(201).json({ data: user, emailSent });
}

export async function resendInvite(request: Request, response: Response): Promise<void> {
  const { id } = userIdSchema.parse(request.params);
  const { user, emailSent } = await userService.resendInvitation(request.user!, id);
  response.status(200).json({ data: user, emailSent });
}

export async function getSuperAdmin(_request: Request, response: Response): Promise<void> {
  response.status(200).json({ data: await userService.getSuperAdmin() });
}

export async function getById(request: Request, response: Response): Promise<void> {
  const { id } = userIdSchema.parse(request.params);
  response.status(200).json({ data: await userService.getUser(request.user!, id) });
}

export async function update(request: Request, response: Response): Promise<void> {
  const { id } = userIdSchema.parse(request.params);
  const input = updateUserSchema.parse(request.body);
  response.status(200).json({ data: await userService.updateUser(request.user!, id, input) });
}

export async function disable(request: Request, response: Response): Promise<void> {
  const { id } = userIdSchema.parse(request.params);
  response.status(200).json({ data: await userService.disableUser(request.user!, id) });
}

export async function enable(request: Request, response: Response): Promise<void> {
  const { id } = userIdSchema.parse(request.params);
  response.status(200).json({ data: await userService.enableUser(request.user!, id) });
}

export async function remove(request: Request, response: Response): Promise<void> {
  const { id } = userIdSchema.parse(request.params);
  await userService.deleteUser(request.user!, id);
  response.status(204).send();
}

import type { Request, Response } from "express";

import { getAiStatus } from "../services/ai-admin.service.js";

export async function status(_request: Request, response: Response): Promise<void> {
  response.status(200).json({ data: await getAiStatus() });
}

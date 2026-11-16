import type { Request, Response } from "express";

import { listAuditLogsSchema } from "../schemas/audit.schema.js";
import * as auditService from "../services/audit.service.js";

export async function list(request: Request, response: Response): Promise<void> {
  const filters = listAuditLogsSchema.parse(request.query);
  const { logs, total } = await auditService.listAuditLogs(filters);

  response.status(200).json({
    data: logs,
    pagination: {
      page: filters.page,
      limit: filters.limit,
      total,
      totalPages: Math.ceil(total / filters.limit),
    },
  });
}

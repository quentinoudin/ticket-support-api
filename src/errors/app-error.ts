export type ErrorCode =
  | "BAD_REQUEST"
  | "VALIDATION_ERROR"
  | "INVALID_JSON"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR"
  | "SERVICE_UNAVAILABLE";

const codeByStatus: Record<number, ErrorCode> = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  429: "RATE_LIMITED",
  503: "SERVICE_UNAVAILABLE",
};

export function codeForStatus(status: number): ErrorCode {
  return codeByStatus[status] ?? "INTERNAL_ERROR";
}

export class AppError extends Error {
  public readonly code: ErrorCode;

  constructor(
    message: string,
    public readonly statusCode: number,
    code?: ErrorCode,
  ) {
    super(message);
    this.name = "AppError";
    this.code = code ?? codeForStatus(statusCode);
  }
}

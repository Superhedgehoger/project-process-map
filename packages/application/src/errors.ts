export type ApplicationErrorCode =
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "NODE_NOT_FOUND"
  | "TASK_NOT_FOUND"
  | "PARENT_NODE_NOT_FOUND"
  | "PROJECT_MISMATCH"
  | "MILESTONE_TASK_FORBIDDEN"
  | "TASK_ALREADY_EXISTS"
  | "ASSET_ALREADY_EXISTS"
  | "IDEMPOTENCY_KEY_REQUIRED"
  | "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD"
  | "FILE_SIZE_INVALID"
  | "ASSET_CONTENT_HASH_MISMATCH"
  | "INVALID_JSON"
  | "REQUEST_TOO_LARGE"
  | "VALIDATION_FAILED"
  | "HULY_ADAPTER_NOT_CONFIGURED"
  | "UPSTREAM_FAILURE"
  | "CONFLICT";

export class ApplicationError extends Error {
  readonly code: ApplicationErrorCode;

  constructor(code: ApplicationErrorCode, message: string) {
    super(message);
    this.name = "ApplicationError";
    this.code = code;
  }
}

export function asApplicationError(error: unknown): ApplicationError {
  if (error instanceof ApplicationError) return error;
  if (error instanceof Error && knownCodes.has(error.message as ApplicationErrorCode)) {
    return new ApplicationError(error.message as ApplicationErrorCode, error.message);
  }
  if (error instanceof Error && error.message.startsWith("Aggregate already exists:")) {
    return new ApplicationError("CONFLICT", error.message);
  }
  return new ApplicationError("UPSTREAM_FAILURE", error instanceof Error ? error.message : String(error));
}

const knownCodes = new Set<ApplicationErrorCode>([
  "UNAUTHORIZED",
  "NOT_FOUND",
  "NODE_NOT_FOUND",
  "TASK_NOT_FOUND",
  "PARENT_NODE_NOT_FOUND",
  "PROJECT_MISMATCH",
  "MILESTONE_TASK_FORBIDDEN",
  "TASK_ALREADY_EXISTS",
  "ASSET_ALREADY_EXISTS",
  "IDEMPOTENCY_KEY_REQUIRED",
  "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
  "FILE_SIZE_INVALID",
  "ASSET_CONTENT_HASH_MISMATCH",
  "INVALID_JSON",
  "REQUEST_TOO_LARGE",
  "VALIDATION_FAILED",
  "HULY_ADAPTER_NOT_CONFIGURED",
  "UPSTREAM_FAILURE",
  "CONFLICT",
]);

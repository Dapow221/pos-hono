/**
 * Centralized, typed application errors.
 *
 * Route handlers throw these; a single `app.onError` handler in index.ts turns
 * them into the standard error envelope `{ error: { code, message, details? } }`.
 * No try/catch scattered through handlers for expected failures.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;
  /** Operational = an expected business/validation error, safe to show the client. */
  readonly isOperational = true;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const Errors = {
  validation: (message: string, details?: unknown) =>
    new AppError(400, "VALIDATION_ERROR", message, details),
  unauthorized: (message = "Authentication required.") =>
    new AppError(401, "UNAUTHORIZED", message),
  forbidden: (message = "Insufficient permission.") => new AppError(403, "FORBIDDEN", message),
  notFound: (message: string) => new AppError(404, "NOT_FOUND", message),
  conflict: (message: string, details?: unknown) =>
    new AppError(409, "CONFLICT", message, details),
  insufficientStock: (details: unknown) =>
    new AppError(409, "INSUFFICIENT_STOCK", "One or more items do not have enough stock.", details),
  insufficientPayment: (details: unknown) =>
    new AppError(402, "INSUFFICIENT_PAYMENT", "Amount paid is less than the total due.", details),
};

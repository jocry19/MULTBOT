/** Base error with a stable machine-readable code. */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

/** Error that must never be retried (validation, integrity, insufficient funds …). */
export class PermanentError extends AppError {
  override readonly name: string = "PermanentError";
}

/** Error that may succeed on retry (network, 429, 5xx, timeout). */
export class TransientError extends AppError {
  override readonly name: string = "TransientError";
}

/** A safety/integrity check failed. Transactions must not be signed or sent. */
export class IntegrityError extends PermanentError {
  override readonly name: string = "IntegrityError";
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

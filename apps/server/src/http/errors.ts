/**
 * A client-facing API error with an HTTP status. The app's error middleware
 * renders `{ error, code? }`; messages must be safe to show (no secrets, no raw
 * provider bodies).
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    /** Extra non-sensitive fields merged into the JSON response (e.g. a correlation id). */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

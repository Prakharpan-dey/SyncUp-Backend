export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string,
    /**
     * Which submitted field caused this, when exactly one did.
     *
     * Lets a client attach the message to the offending input instead of
     * dropping every failure into one banner under a multi-field form, where
     * the user is told something is wrong but not what to change.
     */
    public field?: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

// Convenience factories
export const notFound = (what: string) => new AppError(404, `${what} not found`, 'NOT_FOUND');
export const conflict = (msg: string) => new AppError(409, msg, 'CONFLICT');
export const unauthorized = (msg = 'Unauthorized') => new AppError(401, msg, 'UNAUTHORIZED');
export const forbidden = (msg = 'Forbidden') => new AppError(403, msg, 'FORBIDDEN');
export const badRequest = (msg: string) => new AppError(400, msg, 'BAD_REQUEST');

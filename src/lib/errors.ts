/**
 * Log an API error. Use in catch blocks:
 *
 *   } catch (error) {
 *     captureApiError('POST /api/media', error);
 *     return json({ error: error.message }, 500);
 *   }
 */
export function captureApiError(context: string, error: unknown): void {
  console.error(`[${context}]`, error);
}

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(401, message, 'UNAUTHORIZED');
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(403, message, 'FORBIDDEN');
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(404, `${resource} not found`, 'NOT_FOUND');
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(400, message, 'VALIDATION_ERROR');
  }
}

export class RateLimitError extends AppError {
  constructor() {
    super(429, 'Too many requests', 'RATE_LIMIT');
  }
}

export class PlatformError extends AppError {
  constructor(
    public platform: string,
    message: string,
    public platformCode?: string,
  ) {
    super(502, message, 'PLATFORM_ERROR');
  }
}

export function errorResponse(error: unknown): Response {
  if (error instanceof AppError) {
    return new Response(
      JSON.stringify({
        error: { message: error.message, code: error.code },
      }),
      {
        status: error.statusCode,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  const message = 'Internal server error';
  return new Response(
    JSON.stringify({
      error: { message, code: 'INTERNAL_ERROR' },
    }),
    {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

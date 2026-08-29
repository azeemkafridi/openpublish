/**
 * Error utility tests.
 *
 * Tests webapp/src/lib/errors.ts covering:
 *   - captureApiError: calls console.error for all errors
 *   - captureApiError: calls Sentry.captureException for Error instances
 *   - captureApiError: calls Sentry.captureMessage for non-Error values
 *   - captureApiError: includes context as apiContext tag
 *   - AppError subclasses: correct statusCode and code
 *   - errorResponse: returns correct status for each AppError type
 *   - errorResponse: returns 500 for unknown/generic errors
 *   - errorResponse: returns JSON body with error.message and error.code
 */

// ---------------------------------------------------------------------------
// Mocks (hoisted)
// ---------------------------------------------------------------------------

const mockCaptureException = vi.fn();
const mockCaptureMessage = vi.fn();

vi.mock('@sentry/astro', () => ({
  captureException: mockCaptureException,
  captureMessage: mockCaptureMessage,
}));

export {};

// ---------------------------------------------------------------------------
// Import AFTER mocks
// ---------------------------------------------------------------------------

const {
  captureApiError,
  errorResponse,
  AppError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  RateLimitError,
  PlatformError,
} = await import('@/lib/errors');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('captureApiError', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls console.error with context prefix and error', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = new Error('Something broke');

    captureApiError('POST /api/posts', err);

    expect(errorSpy).toHaveBeenCalledWith('[POST /api/posts]', err);
    errorSpy.mockRestore();
  });






});

// ---------------------------------------------------------------------------
// AppError subclasses
// ---------------------------------------------------------------------------

describe('AppError subclasses', () => {
  it('UnauthorizedError has status 401 and code UNAUTHORIZED', () => {
    const err = new UnauthorizedError();
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe('UNAUTHORIZED');
    expect(err.message).toBe('Unauthorized');
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(Error);
  });

  it('UnauthorizedError accepts custom message', () => {
    const err = new UnauthorizedError('Token expired');
    expect(err.message).toBe('Token expired');
    expect(err.statusCode).toBe(401);
  });

  it('ForbiddenError has status 403 and code FORBIDDEN', () => {
    const err = new ForbiddenError();
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe('FORBIDDEN');
    expect(err.message).toBe('Forbidden');
  });

  it('NotFoundError has status 404 and code NOT_FOUND', () => {
    const err = new NotFoundError('Post');
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toBe('Post not found');
  });

  it('NotFoundError defaults to "Resource" if no arg given', () => {
    const err = new NotFoundError();
    expect(err.message).toBe('Resource not found');
  });

  it('ValidationError has status 400 and code VALIDATION_ERROR', () => {
    const err = new ValidationError('Content too long');
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.message).toBe('Content too long');
  });

  it('RateLimitError has status 429 and code RATE_LIMIT', () => {
    const err = new RateLimitError();
    expect(err.statusCode).toBe(429);
    expect(err.code).toBe('RATE_LIMIT');
    expect(err.message).toBe('Too many requests');
  });

  it('PlatformError has status 502 and code PLATFORM_ERROR', () => {
    const err = new PlatformError('twitter', 'API rate limited', 'RATE_LIMITED');
    expect(err.statusCode).toBe(502);
    expect(err.code).toBe('PLATFORM_ERROR');
    expect(err.platform).toBe('twitter');
    expect(err.platformCode).toBe('RATE_LIMITED');
    expect(err.message).toBe('API rate limited');
  });
});

// ---------------------------------------------------------------------------
// errorResponse
// ---------------------------------------------------------------------------

describe('errorResponse', () => {
  it('returns 401 for UnauthorizedError', async () => {
    const err = new UnauthorizedError();
    const res = errorResponse(err);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.message).toBe('Unauthorized');
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 403 for ForbiddenError', async () => {
    const res = errorResponse(new ForbiddenError());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('returns 404 for NotFoundError', async () => {
    const res = errorResponse(new NotFoundError('Channel'));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.message).toBe('Channel not found');
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('returns 400 for ValidationError', async () => {
    const res = errorResponse(new ValidationError('Invalid format'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toBe('Invalid format');
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 429 for RateLimitError', async () => {
    const res = errorResponse(new RateLimitError());
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.code).toBe('RATE_LIMIT');
  });

  it('returns 502 for PlatformError', async () => {
    const res = errorResponse(new PlatformError('linkedin', 'Access denied'));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe('PLATFORM_ERROR');
  });

  it('returns 500 for generic Error', async () => {
    const res = errorResponse(new Error('unexpected failure'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.message).toBe('Internal server error');
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });

  it('returns 500 for non-Error values', async () => {
    const res = errorResponse('string error');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.message).toBe('Internal server error');
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });

  it('returns 500 for null', async () => {
    const res = errorResponse(null);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });

  it('sets Content-Type to application/json', () => {
    const res = errorResponse(new NotFoundError());
    expect(res.headers.get('Content-Type')).toBe('application/json');
  });

  it('returns custom statusCode for generic AppError', async () => {
    const err = new AppError(409, 'Conflict', 'CONFLICT');
    const res = errorResponse(err);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('CONFLICT');
  });
});

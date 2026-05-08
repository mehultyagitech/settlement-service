import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { createRequestLogger } from '../utils/logger';

// Augment Express Request to carry a logger and traceId
declare global {
  namespace Express {
    interface Request {
      traceId: string;
      log: ReturnType<typeof createRequestLogger>;
    }
  }
}

/**
 * Injects a traceId (from X-Trace-ID header or generated) and a
 * per-request child logger into every request.
 */
export function traceMiddleware(req: Request, res: Response, next: NextFunction): void {
  const traceId = (req.headers['x-trace-id'] as string) || uuidv4();
  req.traceId = traceId;
  req.log = createRequestLogger(traceId);

  // Echo the trace ID back so callers can correlate
  res.setHeader('X-Trace-ID', traceId);

  req.log.info({ method: req.method, url: req.url }, 'Request received');
  next();
}

/**
 * Centralized error handler — converts errors to consistent JSON responses.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  const logger = req.log || createRequestLogger('unknown');

  if (err instanceof ValidationError) {
    logger.warn({ errors: err.errors }, 'Validation error');
    res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'Request validation failed',
      details: err.errors,
      traceId: req.traceId,
    });
    return;
  }

  logger.error({ err }, 'Unhandled error');
  res.status(500).json({
    error: 'INTERNAL_ERROR',
    message: 'An unexpected error occurred',
    traceId: req.traceId,
  });
}

export class ValidationError extends Error {
  constructor(public readonly errors: unknown) {
    super('Validation failed');
    this.name = 'ValidationError';
  }
}

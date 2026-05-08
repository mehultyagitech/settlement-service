import { Logger } from './logger';

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  shouldRetry?: (error: unknown) => boolean;
}

export const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxAttempts: 5,
  baseDelayMs: 200,
  maxDelayMs: 10_000,
  shouldRetry: isRetryableError,
};

export function isRetryableError(error: unknown): boolean {
  if (error instanceof GatewayError) {
    // Retry on 5xx and network/timeout errors; never on 4xx (permanent failures)
    return error.statusCode === undefined || error.statusCode >= 500;
  }
  return true; // Unknown errors are retried by default
}

export class GatewayError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

/**
 * Retry an async operation with exponential backoff + full jitter.
 *
 * Full jitter formula: sleep = rand(0, min(cap, base * 2^attempt))
 * This spreads retries across time, preventing thundering-herd on the gateway.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = DEFAULT_RETRY_OPTIONS,
  logger?: Logger,
): Promise<T> {
  const { maxAttempts, baseDelayMs, maxDelayMs, shouldRetry } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await operation(attempt);
      if (attempt > 1) {
        logger?.info({ attempt }, 'Operation succeeded after retry');
      }
      return result;
    } catch (err) {
      lastError = err;

      const retryable = shouldRetry ? shouldRetry(err) : true;

      if (!retryable) {
        logger?.warn({ attempt, err }, 'Non-retryable error — aborting');
        throw err;
      }

      if (attempt === maxAttempts) {
        logger?.error({ attempt, err }, 'All retry attempts exhausted');
        break;
      }

      // Exponential backoff with full jitter
      const cap = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
      const delayMs = Math.random() * cap;

      logger?.warn(
        { attempt, maxAttempts, delayMs: Math.round(delayMs), err },
        'Retryable error — will retry',
      );

      await sleep(delayMs);
    }
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

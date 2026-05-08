import { withRetry, GatewayError, DEFAULT_RETRY_OPTIONS } from '../utils/retry';
import { Logger } from '../utils/logger';

export interface CaptureRequest {
  preAuthId: string;
  amountCents: number;
  idempotencyKey: string;
}

export interface CaptureResponse {
  success: true;
  chargeId: string;
  capturedAmountCents: number;
  capturedAt: string;
}

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3001';
const GATEWAY_TIMEOUT_MS = parseInt(process.env.GATEWAY_TIMEOUT_MS || '5000', 10);

export async function capturePayment(
  req: CaptureRequest,
  logger: Logger,
): Promise<CaptureResponse> {
  logger.info(
    { preAuthId: req.preAuthId, amountCents: req.amountCents, idempotencyKey: req.idempotencyKey },
    'Attempting payment capture',
  );

  return withRetry(
    async (attempt) => {
      logger.debug({ attempt, idempotencyKey: req.idempotencyKey }, 'Calling payment gateway');

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS);

      let response: Response;
      try {
        response = await fetch(`${GATEWAY_URL}/capture`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(req),
          signal: controller.signal,
        });
      } catch (err: unknown) {
        clearTimeout(timeoutId);
        // Network error or timeout
        const message = err instanceof Error ? err.message : String(err);
        const isTimeout = message.includes('aborted') || message.includes('abort');
        throw new GatewayError(
          isTimeout ? 'Gateway timeout' : `Network error: ${message}`,
          undefined,
        );
      } finally {
        clearTimeout(timeoutId);
      }

      const body = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new GatewayError(
          `Gateway returned ${response.status}`,
          response.status,
          body,
        );
      }

      logger.info({ attempt, chargeId: (body as CaptureResponse).chargeId }, 'Capture successful');
      return body as CaptureResponse;
    },
    {
      ...DEFAULT_RETRY_OPTIONS,
      maxAttempts: 5,
      baseDelayMs: 300,
      maxDelayMs: 8_000,
    },
    logger,
  );
}

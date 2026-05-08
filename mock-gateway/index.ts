/**
 * Mock Payment Gateway
 *
 * Single endpoint: POST /capture
 * Body: { preAuthId: string, amountCents: number, idempotencyKey: string }
 *
 * Behavior:
 *   - ~15% of requests return a 500 or simulate a timeout
 *   - Idempotent: same idempotencyKey always returns the same response
 *   - Validates that amountCents does not exceed what was pre-authorized
 *     (uses a fixed pre-auth store for the demo)
 */

import express, { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import pino from 'pino';

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.GATEWAY_PORT || '3001', 10);
const FAILURE_RATE = parseFloat(process.env.GATEWAY_FAILURE_RATE || '0.15');

const logger = pino({
  level: 'info',
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  base: { service: 'mock-gateway' },
});

// In-memory idempotency store: idempotencyKey → response
const idempotencyStore = new Map<string, object>();

// Simulated pre-auth store: preAuthId → { authorizedAmountCents, consumed }
// Pre-seeded with common test values; real gateway would look these up
const preAuthStore = new Map<string, { authorizedAmountCents: number; consumed: boolean }>([
  ['auth_xyz',  { authorizedAmountCents: 50000, consumed: false }],
  ['auth_test', { authorizedAmountCents: 100000, consumed: false }],
]);

// Auto-register unknown pre-auths with a generous limit for demo ease
function getOrCreatePreAuth(preAuthId: string, requestedAmountCents: number) {
  if (!preAuthStore.has(preAuthId)) {
    // Auto-register: authorize at 2× the requested amount
    preAuthStore.set(preAuthId, {
      authorizedAmountCents: requestedAmountCents * 2,
      consumed: false,
    });
  }
  return preAuthStore.get(preAuthId)!;
}

interface CaptureBody {
  preAuthId: string;
  amountCents: number;
  idempotencyKey: string;
}

app.post('/capture', async (req: Request, res: Response) => {
  const { preAuthId, amountCents, idempotencyKey } = req.body as Partial<CaptureBody>;

  // ── Basic validation ───────────────────────────────────────────────────────
  if (!preAuthId || !idempotencyKey || amountCents === undefined) {
    res.status(400).json({ error: 'Missing required fields: preAuthId, amountCents, idempotencyKey' });
    return;
  }

  if (typeof amountCents !== 'number' || amountCents <= 0) {
    res.status(400).json({ error: 'amountCents must be a positive integer' });
    return;
  }

  logger.info({ preAuthId, amountCents, idempotencyKey }, 'Capture request received');

  // ── Idempotency check ──────────────────────────────────────────────────────
  // If we've seen this key before, return the exact same response
  if (idempotencyStore.has(idempotencyKey)) {
    const cached = idempotencyStore.get(idempotencyKey)!;
    logger.info({ idempotencyKey }, 'Returning cached idempotent response');
    res.status(200).json({ ...cached, idempotent: true });
    return;
  }

  // ── Intentional flakiness (before idempotency store, so retries still hit it) ─
  const roll = Math.random();
  if (roll < FAILURE_RATE) {
    const isTimeout = roll < FAILURE_RATE / 2;
    if (isTimeout) {
      // Simulate a slow timeout: hang for 6 seconds then 503
      logger.warn({ idempotencyKey }, 'Simulating gateway timeout');
      await sleep(6000);
      res.status(503).json({ error: 'Gateway timeout' });
    } else {
      logger.warn({ idempotencyKey }, 'Simulating gateway 500 error');
      res.status(500).json({ error: 'Internal gateway error — please retry' });
    }
    return;
  }

  // ── Pre-auth validation ────────────────────────────────────────────────────
  const preAuth = getOrCreatePreAuth(preAuthId, amountCents);

  if (preAuth.consumed) {
    // Pre-auth already fully consumed (shouldn't happen with idempotency, but safety net)
    res.status(422).json({ error: 'Pre-authorization already consumed', preAuthId });
    return;
  }

  if (amountCents > preAuth.authorizedAmountCents) {
    res.status(422).json({
      error: 'Capture amount exceeds pre-authorization',
      requestedCents: amountCents,
      authorizedCents: preAuth.authorizedAmountCents,
    });
    return;
  }

  // ── Success ────────────────────────────────────────────────────────────────
  preAuth.consumed = true;

  const chargeId = `ch_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
  const successResponse = {
    success: true,
    chargeId,
    preAuthId,
    capturedAmountCents: amountCents,
    capturedAt: new Date().toISOString(),
  };

  // Store for idempotency
  idempotencyStore.set(idempotencyKey, successResponse);

  logger.info({ chargeId, amountCents, idempotencyKey }, 'Capture successful');
  res.status(200).json(successResponse);
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'mock-gateway', failureRate: FAILURE_RATE });
});

app.listen(PORT, () => {
  logger.info({ port: PORT, failureRate: FAILURE_RATE }, 'Mock payment gateway listening');
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

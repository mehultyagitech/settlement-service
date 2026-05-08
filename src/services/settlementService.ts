import { Database } from 'sql.js';
import { v4 as uuidv4 } from 'uuid';
import { settlementRepo, SettlementRow } from '../db/database';
import { computeCharge } from './chargeCalculator';
import { capturePayment } from './gatewayClient';
import { Logger } from '../utils/logger';
import { BookingCompletedEvent } from '../routes/events';

export interface SettlementResult {
  settlement: SettlementRow;
  alreadyProcessed: boolean;
}

export async function processBookingCompleted(
  event: BookingCompletedEvent,
  db: Database,
  logger: Logger,
): Promise<SettlementResult> {
  const { bookingId } = event;

  // ── 1. Fast-path idempotency check ──────────────────────────────────────
  const existing = settlementRepo.findByBookingId(db, bookingId);
  if (existing) {
    logger.info({ bookingId, status: existing.status }, 'Settlement already exists — returning cached result');
    return { settlement: existing, alreadyProcessed: true };
  }

  // ── 2. Acquire advisory lock (prevents concurrent duplicates) ────────────
  const lockAcquired = settlementRepo.acquireLock(db, bookingId);
  if (!lockAcquired) {
    logger.warn({ bookingId }, 'Could not acquire processing lock — concurrent request in flight');
    await sleep(500);
    const afterWait = settlementRepo.findByBookingId(db, bookingId);
    if (afterWait) {
      return { settlement: afterWait, alreadyProcessed: true };
    }
    throw new Error(`Concurrent processing conflict for bookingId=${bookingId}`);
  }

  try {
    // ── 3. Double-check after lock (TOCTOU guard) ────────────────────────
    const existingAfterLock = settlementRepo.findByBookingId(db, bookingId);
    if (existingAfterLock) {
      logger.info({ bookingId }, 'Settlement found after lock — another process completed it');
      return { settlement: existingAfterLock, alreadyProcessed: true };
    }

    // ── 4. Compute charge ────────────────────────────────────────────────
    const charge = computeCharge({
      baseFareCents:  event.baseFareCents,
      includedUnits:  event.includedUnits,
      actualUnits:    event.actualUnits,
      scheduledEnd:   new Date(event.scheduledEnd),
      actualEnd:      new Date(event.actualEnd),
    });

    logger.info({ bookingId, ...charge }, 'Charge computed');

    if (charge.totalAmountCents > event.preAuthAmountCents) {
      logger.warn({
        bookingId,
        totalAmountCents: charge.totalAmountCents,
        preAuthAmountCents: event.preAuthAmountCents,
      }, 'Total charge exceeds pre-auth amount — flagging for review');
    }

    const settlementId = uuidv4();
    // Deterministic key: survives crashes — gateway deduplicates on retry
    const captureIdempotencyKey = `settle:${bookingId}`;

    // ── 5. Insert pending row (immutable charge breakdown) ───────────────
    const pendingRow: Omit<SettlementRow, 'created_at' | 'updated_at'> = {
      id: settlementId,
      booking_id: bookingId,
      user_id: event.userId,
      status: 'pending',
      base_fare_cents: charge.baseFareCents,
      overage_cents: charge.overageCents,
      late_fee_cents: charge.lateFeeCents,
      total_amount_cents: charge.totalAmountCents,
      pre_auth_id: event.preAuthId,
      capture_idempotency_key: captureIdempotencyKey,
      gateway_response: null,
      scheduled_end: event.scheduledEnd,
      actual_end: event.actualEnd,
      included_units: event.includedUnits,
      actual_units: event.actualUnits,
    };

    settlementRepo.insert(db, pendingRow);
    logger.info({ bookingId, settlementId }, 'Pending settlement row created');

    // ── 6. Capture from gateway (with retry) ────────────────────────────
    let finalStatus: SettlementRow['status'];
    let gatewayResponse: string;

    try {
      const captureResp = await capturePayment(
        { preAuthId: event.preAuthId, amountCents: charge.totalAmountCents, idempotencyKey: captureIdempotencyKey },
        logger,
      );
      finalStatus = 'captured';
      gatewayResponse = JSON.stringify(captureResp);
      logger.info({ bookingId, chargeId: captureResp.chargeId }, 'Payment captured successfully');
    } catch (err) {
      finalStatus = 'failed';
      gatewayResponse = JSON.stringify({ error: err instanceof Error ? err.message : String(err), failedAt: new Date().toISOString() });
      logger.error({ bookingId, err }, 'Payment capture failed after all retries');
    }

    // ── 7. Update to final status ────────────────────────────────────────
    settlementRepo.updateStatus(db, bookingId, finalStatus, gatewayResponse);
    const finalRow = settlementRepo.findByBookingId(db, bookingId)!;

    // ── 8. Emit BookingSettled event (logged; swap for Kafka/SNS in prod) ─
    logger.info({
      event: 'BookingSettled',
      bookingId,
      userId: event.userId,
      totalAmountCents: charge.totalAmountCents,
      status: finalStatus,
    }, '[EVENT EMITTED] BookingSettled');

    return { settlement: finalRow, alreadyProcessed: false };

  } finally {
    settlementRepo.releaseLock(db, bookingId);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

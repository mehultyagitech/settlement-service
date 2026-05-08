import { Router, Request, Response, NextFunction } from 'express';
import { settlementRepo, SettlementRow, getDb } from '../db/database';

const router = Router();

router.get('/:bookingId', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { bookingId } = req.params;
    req.log.info({ bookingId }, 'Fetching settlement');

    const db = await getDb();
    const row = settlementRepo.findByBookingId(db, bookingId);

    if (!row) {
      res.status(404).json({
        error: 'NOT_FOUND',
        message: `No settlement found for bookingId=${bookingId}`,
        traceId: req.traceId,
      });
      return;
    }

    res.status(200).json(formatSettlement(row, req.traceId));
  } catch (err) {
    next(err);
  }
});

function formatSettlement(row: SettlementRow, traceId: string) {
  let gatewayResponse: unknown = null;
  if (row.gateway_response) {
    try { gatewayResponse = JSON.parse(row.gateway_response); } catch { gatewayResponse = row.gateway_response; }
  }
  return {
    settlementId: row.id,
    bookingId: row.booking_id,
    userId: row.user_id,
    status: row.status,
    breakdown: {
      baseFareCents: row.base_fare_cents,
      overageCents: row.overage_cents,
      lateFeeCents: row.late_fee_cents,
      totalAmountCents: row.total_amount_cents,
    },
    payment: {
      preAuthId: row.pre_auth_id,
      captureIdempotencyKey: row.capture_idempotency_key,
      gatewayResponse,
    },
    booking: {
      scheduledEnd: row.scheduled_end,
      actualEnd: row.actual_end,
      includedUnits: row.included_units,
      actualUnits: row.actual_units,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    traceId,
  };
}

export default router;

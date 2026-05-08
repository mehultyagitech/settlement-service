import { Router, Request, Response, NextFunction } from 'express';
import { bookingCompletedSchema } from '../utils/validation';
import { ValidationError } from '../middleware';
import { processBookingCompleted } from '../services/settlementService';
import { getDb } from '../db/database';

export type BookingCompletedEvent = {
  event: 'BookingCompleted';
  bookingId: string;
  userId: string;
  scheduledEnd: string;
  actualEnd: string;
  includedUnits: number;
  actualUnits: number;
  baseFareCents: number;
  preAuthId: string;
  preAuthAmountCents: number;
};

const router = Router();

router.post(
  '/booking-completed',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = bookingCompletedSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.flatten().fieldErrors);
      }

      const event = parsed.data as BookingCompletedEvent;
      req.log.info({ bookingId: event.bookingId }, 'Processing BookingCompleted event');

      const db = await getDb();
      const { settlement, alreadyProcessed } = await processBookingCompleted(event, db, req.log);

      const statusCode = alreadyProcessed ? 200 : 202;
      res.status(statusCode).json({
        status: settlement.status,
        bookingId: settlement.booking_id,
        settlementId: settlement.id,
        totalAmountCents: settlement.total_amount_cents,
        breakdown: {
          baseFareCents: settlement.base_fare_cents,
          overageCents: settlement.overage_cents,
          lateFeeCents: settlement.late_fee_cents,
        },
        alreadyProcessed,
        traceId: req.traceId,
      });
    } catch (err) {
      next(err);
    }
  },
);

export default router;

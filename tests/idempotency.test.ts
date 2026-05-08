import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createInMemoryDb, settlementRepo } from '../src/db/database';
import { processBookingCompleted } from '../src/services/settlementService';
import { createRequestLogger } from '../src/utils/logger';
import type { Database } from 'sql.js';

const sampleEvent = {
  event: 'BookingCompleted' as const,
  bookingId: 'bk_idempotency_test',
  userId: 'user_123',
  scheduledEnd: '2026-04-10T18:00:00Z',
  actualEnd:    '2026-04-10T19:30:00Z',
  includedUnits: 200,
  actualUnits: 237,
  baseFareCents: 8500,
  preAuthId: 'auth_xyz',
  preAuthAmountCents: 50000,
};

const logger = createRequestLogger('test-trace');

// Mock gateway: succeeds on first call
vi.mock('../src/services/gatewayClient', () => {
  let callCount = 0;
  return {
    capturePayment: vi.fn(async () => {
      callCount++;
      return {
        success: true,
        chargeId: `ch_test_${callCount}`,
        capturedAmountCents: 12425,
        capturedAt: new Date().toISOString(),
      };
    }),
  };
});

describe('Idempotency under retry', () => {
  let db: Database;

  beforeEach(async () => {
    db = await createInMemoryDb();
    vi.clearAllMocks();
  });

  afterEach(() => {
    db.close();
  });

  it('charges the card EXACTLY ONCE when the same event is submitted 10 times', async () => {
    const { capturePayment } = await import('../src/services/gatewayClient');

    // Submit 10 times sequentially (concurrent would race on single-threaded Node)
    const results = [];
    for (let i = 0; i < 10; i++) {
      results.push(await processBookingCompleted(sampleEvent, db, logger));
    }

    // Gateway must have been called exactly once
    expect((capturePayment as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);

    // All results reference the same settlement
    const uniqueIds = new Set(results.map(r => r.settlement.id));
    expect(uniqueIds.size).toBe(1);

    results.forEach(r => expect(r.settlement.booking_id).toBe(sampleEvent.bookingId));
  });

  it('returns alreadyProcessed=true on all duplicate submissions after the first', async () => {
    const first = await processBookingCompleted(sampleEvent, db, logger);
    expect(first.alreadyProcessed).toBe(false);

    for (let i = 0; i < 9; i++) {
      const result = await processBookingCompleted(sampleEvent, db, logger);
      expect(result.alreadyProcessed).toBe(true);
      expect(result.settlement.id).toBe(first.settlement.id);
    }
  });

  it('settlement breakdown is immutable across retries', async () => {
    await processBookingCompleted(sampleEvent, db, logger);
    const row = settlementRepo.findByBookingId(db, sampleEvent.bookingId);
    expect(row).toBeDefined();
    // Spec example: $85 + $9.25 overage (37×$0.25) + $30 late (2h×$15) = $124.25
    expect(row!.base_fare_cents).toBe(8500);
    expect(row!.overage_cents).toBe(925);
    expect(row!.late_fee_cents).toBe(3000);
    expect(row!.total_amount_cents).toBe(12425);
  });

  it('does not create a second row for the same bookingId', async () => {
    await processBookingCompleted(sampleEvent, db, logger);
    await processBookingCompleted(sampleEvent, db, logger);
    await processBookingCompleted(sampleEvent, db, logger);
    expect(settlementRepo.count(db, sampleEvent.bookingId)).toBe(1);
  });

  it('different bookingIds produce independent settlements', async () => {
    const eventA = { ...sampleEvent, bookingId: 'bk_aaa', preAuthId: 'auth_aaa' };
    const eventB = { ...sampleEvent, bookingId: 'bk_bbb', preAuthId: 'auth_bbb' };

    const a = await processBookingCompleted(eventA, db, logger);
    const b = await processBookingCompleted(eventB, db, logger);

    expect(a.settlement.id).not.toBe(b.settlement.id);
    expect(a.settlement.booking_id).toBe('bk_aaa');
    expect(b.settlement.booking_id).toBe('bk_bbb');
  });
});

describe('Charge computation in settlement flow', () => {
  let db: Database;

  beforeEach(async () => {
    db = await createInMemoryDb();
    vi.clearAllMocks();
  });

  afterEach(() => {
    db.close();
  });

  it('persists the correct breakdown from the spec example', async () => {
    await processBookingCompleted(sampleEvent, db, logger);
    const row = settlementRepo.findByBookingId(db, sampleEvent.bookingId);
    expect(row!.base_fare_cents).toBe(8500);
    expect(row!.overage_cents).toBe(925);
    expect(row!.late_fee_cents).toBe(3000);
    expect(row!.total_amount_cents).toBe(12425);
  });

  it('records zero late fee when booking is on time', async () => {
    const onTimeEvent = {
      ...sampleEvent, bookingId: 'bk_ontime', preAuthId: 'auth_ontime',
      scheduledEnd: '2026-04-10T18:00:00Z', actualEnd: '2026-04-10T18:00:00Z',
    };
    await processBookingCompleted(onTimeEvent, db, logger);
    const row = settlementRepo.findByBookingId(db, 'bk_ontime');
    expect(row!.late_fee_cents).toBe(0);
  });

  it('records zero overage when within included units', async () => {
    const withinUnitsEvent = {
      ...sampleEvent, bookingId: 'bk_within', preAuthId: 'auth_within',
      includedUnits: 300, actualUnits: 237,
    };
    await processBookingCompleted(withinUnitsEvent, db, logger);
    const row = settlementRepo.findByBookingId(db, 'bk_within');
    expect(row!.overage_cents).toBe(0);
  });
});

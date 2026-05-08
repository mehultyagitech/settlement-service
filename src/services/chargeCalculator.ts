/**
 * Charge calculation service.
 *
 * All monetary values are stored/returned in cents (integer) to avoid
 * floating-point rounding issues.
 *
 * Business rules:
 *   - Base fare       : taken directly from event payload
 *   - Usage overage   : $0.25 per unit over includedUnits  (25 cents)
 *   - Late-return fee : $15.00 per hour past scheduledEnd  (1500 cents)
 *     Partial hours are rounded UP — a 90-minute late return = 2 hours = $30
 */

export interface ChargeBreakdown {
  baseFareCents: number;
  overageCents: number;
  lateFeeCents: number;
  totalAmountCents: number;
}

export interface ChargeInput {
  baseFareCents: number;
  includedUnits: number;
  actualUnits: number;
  scheduledEnd: Date;
  actualEnd: Date;
}

const OVERAGE_CENTS_PER_UNIT = 25;   // $0.25
const LATE_FEE_CENTS_PER_HOUR = 1500; // $15.00
const MS_PER_HOUR = 1000 * 60 * 60;

export function computeCharge(input: ChargeInput): ChargeBreakdown {
  const {
    baseFareCents,
    includedUnits,
    actualUnits,
    scheduledEnd,
    actualEnd,
  } = input;

  // ── Validation ──────────────────────────────────────────────────────────
  if (baseFareCents < 0) throw new Error('baseFareCents must be non-negative');
  if (includedUnits < 0) throw new Error('includedUnits must be non-negative');
  if (actualUnits < 0)   throw new Error('actualUnits must be non-negative');

  // ── Usage overage ────────────────────────────────────────────────────────
  const excessUnits = Math.max(0, actualUnits - includedUnits);
  const overageCents = excessUnits * OVERAGE_CENTS_PER_UNIT;

  // ── Late-return fee ──────────────────────────────────────────────────────
  const lateMs = Math.max(0, actualEnd.getTime() - scheduledEnd.getTime());
  // ceil: any partial hour counts as a full hour
  const lateHours = Math.ceil(lateMs / MS_PER_HOUR);
  const lateFeeCents = lateHours * LATE_FEE_CENTS_PER_HOUR;

  // ── Total ────────────────────────────────────────────────────────────────
  const totalAmountCents = baseFareCents + overageCents + lateFeeCents;

  return {
    baseFareCents,
    overageCents,
    lateFeeCents,
    totalAmountCents,
  };
}

import { describe, it, expect } from 'vitest';
import { computeCharge } from '../src/services/chargeCalculator';

describe('computeCharge', () => {
  const baseInput = {
    baseFareCents: 8500,
    includedUnits: 200,
    actualUnits: 237,
    scheduledEnd: new Date('2026-04-10T18:00:00Z'),
    actualEnd: new Date('2026-04-10T19:30:00Z'),
  };

  it('matches the example from the spec', () => {
    // Spec example:
    //   baseFare:   $85.00 (8500 cents)
    //   overage:    37 units × $0.25 = $9.25 (925 cents)
    //   late fee:   1.5 hours → ceil = 2h × $15 = $30 (3000 cents)
    //   total:      $124.25 (12425 cents)
    const result = computeCharge(baseInput);

    expect(result.baseFareCents).toBe(8500);
    expect(result.overageCents).toBe(925);       // 37 × 25
    expect(result.lateFeeCents).toBe(3000);      // 2h × 1500
    expect(result.totalAmountCents).toBe(12425); // 8500 + 925 + 3000
  });

  it('zero overage when actualUnits <= includedUnits', () => {
    const result = computeCharge({ ...baseInput, actualUnits: 150 });
    expect(result.overageCents).toBe(0);
  });

  it('zero overage when actualUnits exactly equals includedUnits', () => {
    const result = computeCharge({ ...baseInput, actualUnits: 200 });
    expect(result.overageCents).toBe(0);
  });

  it('no late fee when booking ends on time', () => {
    const result = computeCharge({
      ...baseInput,
      scheduledEnd: new Date('2026-04-10T18:00:00Z'),
      actualEnd:    new Date('2026-04-10T18:00:00Z'),
    });
    expect(result.lateFeeCents).toBe(0);
  });

  it('no late fee when booking ends early', () => {
    const result = computeCharge({
      ...baseInput,
      scheduledEnd: new Date('2026-04-10T18:00:00Z'),
      actualEnd:    new Date('2026-04-10T17:00:00Z'),
    });
    expect(result.lateFeeCents).toBe(0);
  });

  it('rounds partial hours UP for late fee (1 second late = 1 hour charge)', () => {
    const result = computeCharge({
      ...baseInput,
      scheduledEnd: new Date('2026-04-10T18:00:00Z'),
      actualEnd:    new Date('2026-04-10T18:00:01Z'), // 1 second late
    });
    expect(result.lateFeeCents).toBe(1500); // ceil(1/3600 hours) = 1 hour
  });

  it('charges exactly 1 hour for exactly 60 minutes late', () => {
    const result = computeCharge({
      ...baseInput,
      scheduledEnd: new Date('2026-04-10T18:00:00Z'),
      actualEnd:    new Date('2026-04-10T19:00:00Z'), // exactly 1h
    });
    expect(result.lateFeeCents).toBe(1500);
  });

  it('charges 3 hours for 2h 1s late (ceil behavior)', () => {
    const result = computeCharge({
      ...baseInput,
      scheduledEnd: new Date('2026-04-10T18:00:00Z'),
      actualEnd:    new Date('2026-04-10T20:00:01Z'), // 2h 1s
    });
    expect(result.lateFeeCents).toBe(4500); // ceil = 3 hours
  });

  it('handles zero base fare', () => {
    const result = computeCharge({ ...baseInput, baseFareCents: 0 });
    expect(result.baseFareCents).toBe(0);
    expect(result.totalAmountCents).toBe(result.overageCents + result.lateFeeCents);
  });

  it('handles all zeros (no charges at all)', () => {
    const result = computeCharge({
      baseFareCents: 0,
      includedUnits: 100,
      actualUnits: 100,
      scheduledEnd: new Date('2026-04-10T18:00:00Z'),
      actualEnd:    new Date('2026-04-10T18:00:00Z'),
    });
    expect(result.overageCents).toBe(0);
    expect(result.lateFeeCents).toBe(0);
    expect(result.totalAmountCents).toBe(0);
  });

  it('throws on negative baseFareCents', () => {
    expect(() => computeCharge({ ...baseInput, baseFareCents: -1 })).toThrow();
  });

  it('throws on negative actualUnits', () => {
    expect(() => computeCharge({ ...baseInput, actualUnits: -1 })).toThrow();
  });

  it('computes large overage correctly', () => {
    const result = computeCharge({ ...baseInput, actualUnits: 1200, includedUnits: 200 });
    // 1000 excess units × $0.25 = $250 = 25000 cents
    expect(result.overageCents).toBe(25000);
  });
});

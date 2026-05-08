import { z } from 'zod';

// ISO 8601 datetime string validator
const isoDatetime = z
  .string()
  .refine((s) => !isNaN(Date.parse(s)), { message: 'Must be a valid ISO 8601 datetime string' });

export const bookingCompletedSchema = z.object({
  event: z.literal('BookingCompleted'),
  bookingId: z.string().min(1, 'bookingId is required'),
  userId: z.string().min(1, 'userId is required'),
  scheduledEnd: isoDatetime,
  actualEnd: isoDatetime,
  includedUnits: z.number().int().min(0),
  actualUnits: z.number().int().min(0),
  baseFareCents: z.number().int().min(0),
  preAuthId: z.string().min(1, 'preAuthId is required'),
  preAuthAmountCents: z.number().int().min(0),
});

export type BookingCompletedPayload = z.infer<typeof bookingCompletedSchema>;

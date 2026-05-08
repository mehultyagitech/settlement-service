import express from 'express';
import { traceMiddleware, errorHandler } from './middleware';
import eventsRouter from './routes/events';
import settlementsRouter from './routes/settlements';
import healthRouter from './routes/health';

export function createApp() {
  const app = express();

  // ── Global middleware ──────────────────────────────────────────────────────
  app.use(express.json({ limit: '1mb' }));
  app.use(traceMiddleware);

  // ── Routes ─────────────────────────────────────────────────────────────────
  app.use('/health', healthRouter);
  app.use('/events', eventsRouter);
  app.use('/settlements', settlementsRouter);

  // ── 404 catch-all ──────────────────────────────────────────────────────────
  app.use((_req, res) => {
    res.status(404).json({ error: 'NOT_FOUND', message: 'Route not found' });
  });

  // ── Error handler (must be last) ───────────────────────────────────────────
  app.use(errorHandler);

  return app;
}

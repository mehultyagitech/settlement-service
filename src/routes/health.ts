import { Router } from 'express';
import { getDb } from '../db/database';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const db = await getDb();
    db.exec('SELECT 1');
    res.status(200).json({ status: 'ok', service: 'settlement-service', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'degraded', error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;

import initSqlJs, { Database, SqlJsStatic } from 'sql.js';
import path from 'path';
import fs from 'fs';

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'settlements.db');

let _sql: SqlJsStatic | null = null;
let _db: Database | null = null;
let _saveInterval: ReturnType<typeof setInterval> | null = null;

async function getSql(): Promise<SqlJsStatic> {
  if (!_sql) {
    _sql = await initSqlJs();
  }
  return _sql;
}

export async function getDb(): Promise<Database> {
  if (_db) return _db;

  const SQL = await getSql();

  const dbDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    _db = new SQL.Database(fileBuffer);
  } else {
    _db = new SQL.Database();
  }

  applyMigrations(_db);

  // sql.js is in-memory — persist to disk every 2 seconds
  _saveInterval = setInterval(() => saveDb(), 2000);

  return _db;
}

export function saveDb(): void {
  if (!_db) return;
  const dbDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  const data = _db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

export function closeDb(): void {
  if (_saveInterval) {
    clearInterval(_saveInterval);
    _saveInterval = null;
  }
  if (_db) {
    saveDb();
    _db.close();
    _db = null;
  }
}

export async function createInMemoryDb(): Promise<Database> {
  const SQL = await getSql();
  const db = new SQL.Database();
  applyMigrations(db);
  return db;
}

function applyMigrations(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS settlements (
      id               TEXT    PRIMARY KEY,
      booking_id       TEXT    NOT NULL UNIQUE,
      user_id          TEXT    NOT NULL,
      status           TEXT    NOT NULL,
      base_fare_cents        INTEGER NOT NULL,
      overage_cents          INTEGER NOT NULL,
      late_fee_cents         INTEGER NOT NULL,
      total_amount_cents     INTEGER NOT NULL,
      pre_auth_id            TEXT    NOT NULL,
      capture_idempotency_key TEXT   NOT NULL UNIQUE,
      gateway_response       TEXT,
      scheduled_end          TEXT    NOT NULL,
      actual_end             TEXT    NOT NULL,
      included_units         INTEGER NOT NULL,
      actual_units           INTEGER NOT NULL,
      created_at             TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at             TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_settlements_booking_id ON settlements(booking_id);
    CREATE TABLE IF NOT EXISTS processing_locks (
      booking_id   TEXT PRIMARY KEY,
      locked_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

export interface SettlementRow {
  id: string;
  booking_id: string;
  user_id: string;
  status: 'pending' | 'captured' | 'failed';
  base_fare_cents: number;
  overage_cents: number;
  late_fee_cents: number;
  total_amount_cents: number;
  pre_auth_id: string;
  capture_idempotency_key: string;
  gateway_response: string | null;
  scheduled_end: string;
  actual_end: string;
  included_units: number;
  actual_units: number;
  created_at: string;
  updated_at: string;
}

function queryAll<T>(db: Database, sql: string, params: (string | number | null)[] = []): T[] {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows: T[] = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject() as T);
  }
  stmt.free();
  return rows;
}

function queryOne<T>(db: Database, sql: string, params: (string | number | null)[] = []): T | undefined {
  return queryAll<T>(db, sql, params)[0];
}

export const settlementRepo = {
  findByBookingId(db: Database, bookingId: string): SettlementRow | undefined {
    return queryOne<SettlementRow>(db, 'SELECT * FROM settlements WHERE booking_id = ?', [bookingId]);
  },

  insert(db: Database, row: Omit<SettlementRow, 'created_at' | 'updated_at'>): void {
    db.run(
      `INSERT INTO settlements (
        id, booking_id, user_id, status,
        base_fare_cents, overage_cents, late_fee_cents, total_amount_cents,
        pre_auth_id, capture_idempotency_key, gateway_response,
        scheduled_end, actual_end, included_units, actual_units
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        row.id, row.booking_id, row.user_id, row.status,
        row.base_fare_cents, row.overage_cents, row.late_fee_cents, row.total_amount_cents,
        row.pre_auth_id, row.capture_idempotency_key, row.gateway_response,
        row.scheduled_end, row.actual_end, row.included_units, row.actual_units,
      ],
    );
  },

  updateStatus(db: Database, bookingId: string, status: SettlementRow['status'], gatewayResponse: string | null): void {
    db.run(
      `UPDATE settlements SET status=?, gateway_response=?, updated_at=datetime('now') WHERE booking_id=?`,
      [status, gatewayResponse, bookingId],
    );
  },

  acquireLock(db: Database, bookingId: string): boolean {
    try {
      db.run('INSERT INTO processing_locks (booking_id) VALUES (?)', [bookingId]);
      return true;
    } catch {
      return false;
    }
  },

  releaseLock(db: Database, bookingId: string): void {
    db.run('DELETE FROM processing_locks WHERE booking_id = ?', [bookingId]);
  },

  count(db: Database, bookingId: string): number {
    const row = queryOne<{ cnt: number }>(db, 'SELECT COUNT(*) as cnt FROM settlements WHERE booking_id = ?', [bookingId]);
    return row?.cnt ?? 0;
  },
};

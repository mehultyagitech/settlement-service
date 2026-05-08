# settlement-service

A production-grade booking settlement microservice. Receives `BookingCompleted` events, computes the final charge, captures payment from a pre-authorization via a mock gateway, and persists an immutable settlement record.

---

## Running Locally Without Docker(single command)

```bash
npm run start:all

# Terminal 1 — mock gateway
GATEWAY_PORT=3001 node dist/mock-gateway/index.js

# Terminal 2 — settlement service
GATEWAY_URL=http://localhost:3001 node dist/src/index.js
```

## Quick Start with Docker (single command)

```bash
docker compose up --build
```

Both services start, health-check each other, and are ready to accept traffic.

| Service            | URL                   |
|--------------------|-----------------------|
| Settlement Service | http://localhost:3000 |
| Mock Gateway       | http://localhost:3001 |

---

**Run tests:**
```bash
npm test
```

---

## Postman Collection & Workflows

Import [settlement-collection.json](settlement-collection.json) into Postman to access the complete API test suite with **four pre-built workflows**:

### Workflows Available

1. **Complete Settlement API Workflow** (`complete-settlement-test-workflow`)  
   Run all 10 test cases in sequence:  
   Health → PostBooking → Idempotency → GetSettlement → ChargeScenarios → ErrorCases  
   **Use this for comprehensive testing.**

2. **Core Happy Path Workflow** (`core-happy-path-workflow`)  
   Quick 4-step validation: Health → Post → Verify Idempotency → Get  
   **Use this for smoke tests.**

3. **Charge Calculation Scenarios** (`charge-calculation-workflow`)  
   Tests all charge-computation edge cases:  
   On-time (no fees) → Late fees → Overage units → Combined charges  
   **Use this to validate billing logic.**

4. **Error Handling Workflow** (`error-handling-workflow`)  
   Tests error cases: Non-existent settlement (404) → Invalid request (400)  
   **Use this to verify error responses.**

### How to Run

1. **Import the collection** in Postman: Click Import → select `settlement-collection.json`
2. **Open Workflows** tab in Postman
3. **Select a workflow** from the list
4. **Click Run** — all steps execute in sequence

---

## API Reference

### `POST /events/booking-completed`

Ingest a `BookingCompleted` event. Fully idempotent — submitting the same `bookingId` any number of times charges the card exactly once.

**Request:**
```json
{
  "event": "BookingCompleted",
  "bookingId": "bk_8f2a",
  "userId": "user_123",
  "scheduledEnd": "2026-04-10T18:00:00Z",
  "actualEnd": "2026-04-10T19:30:00Z",
  "includedUnits": 200,
  "actualUnits": 237,
  "baseFareCents": 8500,
  "preAuthId": "auth_xyz",
  "preAuthAmountCents": 50000
}
```

**Response** — `202` on first processing, `200` on duplicates:
```json
{
  "status": "captured",
  "bookingId": "bk_8f2a",
  "settlementId": "3f2a1b4c-...",
  "totalAmountCents": 12425,
  "breakdown": {
    "baseFareCents": 8500,
    "overageCents": 925,
    "lateFeeCents": 3000
  },
  "alreadyProcessed": false,
  "traceId": "a1b2c3d4-..."
}
```

**Idempotency response** (status `200`, `alreadyProcessed: true`):  
Returns the same body as the original response — no side effects replayed.

---

### `GET /settlements/:bookingId`

Retrieve the full settlement record.

```bash
curl http://localhost:3000/settlements/bk_8f2a
```

**404** if not found. **200** with full breakdown if found.

---

### `GET /health`

```json
{ "status": "ok", "service": "settlement-service", "timestamp": "..." }
```

---

## Charge Calculation

| Component     | Rule                                                           |
|---------------|----------------------------------------------------------------|
| Base fare     | Taken directly from event payload                              |
| Usage overage | `max(0, actualUnits − includedUnits) × $0.25` (25 cents/unit) |
| Late fee      | `ceil(lateMs / 1h) × $15.00` — partial hours round **up**     |
| **Total**     | Sum of all three                                               |

**Spec example** (`bk_8f2a`):

```
Base fare:  $85.00  (8500 cents)
Overage:    37 units × $0.25 = $9.25  (925 cents)
Late fee:   1.5 hours → ceil = 2 × $15 = $30.00  (3000 cents)
──────────────────────────────────────────────────
Total:      $124.25  (12425 cents)
```

> **Partial-hour rounding decision:** The spec says "$15 per hour." This implementation uses `Math.ceil` — 1 second late = 1 full hour billed. This is the strictest interpretation. A lenient interpretation would use `Math.floor`. Documented here as a deliberate call.

---

## Architecture

```
POST /events/booking-completed
        │
        ▼
  ① Validate payload (Zod schema)
        │
        ▼
  ② Fast-path idempotency check (SELECT by bookingId)
     → If found: return cached result immediately (no gateway call)
        │
        ▼
  ③ Acquire DB advisory lock (INSERT INTO processing_locks)
     → Prevents two concurrent requests from both racing past step ②
        │
        ▼
  ④ Double-check after lock (TOCTOU guard)
        │
        ▼
  ⑤ Compute charge (pure function — baseFare + overage + lateFee)
        │
        ▼
  ⑥ INSERT 'pending' settlement row
     (charge breakdown is written here — never changes)
        │
        ▼
  ⑦ Call mock gateway with deterministic idempotency key
     (key = "settle:{bookingId}" — survives crashes and retries)
     Retry: exponential backoff + full jitter, up to 5 attempts
        │
        ▼
  ⑧ UPDATE settlement → 'captured' or 'failed'
        │
        ▼
  ⑨ Release lock
        │
        ▼
  ⑩ Log BookingSettled event (would publish to Kafka/SNS in prod)
```

---

## Key Design Decisions

### Three-layer Idempotency

**Layer 1 — Fast-path SELECT**: The very first thing on any request is a DB lookup by `bookingId`. If a settlement exists (in any state), return it immediately. Zero work done.

**Layer 2 — Advisory lock**: `processing_locks` table with a `UNIQUE` constraint on `booking_id`. If two concurrent requests both pass the fast-path check simultaneously, only one succeeds on the `INSERT INTO processing_locks`. The loser waits briefly and re-checks.

**Layer 3 — Deterministic gateway idempotency key**: The gateway is called with `settle:{bookingId}`. If the service crashes between the gateway call and the DB update, the retry sends the same key — the gateway recognizes it and returns the original response without a second charge. The card is **never charged twice**, even across process restarts.

### Retry Strategy: Exponential Backoff + Full Jitter

```
sleep = rand(0, min(maxDelay, baseDelay × 2^attempt))
```

Full jitter (vs. equal jitter or no jitter) spreads retries uniformly across the time window. When many bookings complete simultaneously and all hit a flaky gateway, full jitter prevents the thundering-herd effect where they all retry in lock-step.

Configuration: 5 max attempts, 300ms base, 8s max delay.

### Why sql.js (Pure-WASM SQLite)?

sql.js is a WebAssembly port of SQLite with zero native compilation dependencies — `npm install` works everywhere without C++ toolchains or prebuilt binaries. The data persists to a file on disk via periodic flush (every 2 seconds) and on graceful shutdown.

In production with multiple replicas, swap for Postgres: the repository pattern in `src/db/database.ts` isolates all DB calls behind a clean interface — the service layer never touches SQL directly.

### Mock Gateway Flakiness

The mock gateway (`mock-gateway/index.ts`) fails ~15% of requests (configurable via `GATEWAY_FAILURE_RATE` env var). Half of failures are hard 500s, half simulate network timeouts (6-second hang → 503). This exercises both timeout handling and 5xx retry logic in the client.

Idempotency on the gateway side is handled by an in-memory `Map<idempotencyKey, response>`. A real gateway (Stripe, Adyen) handles this server-side.

---

## Project Structure

```
settlement-service/
├── src/
│   ├── index.ts                  — Entry point, graceful shutdown
│   ├── app.ts                    — Express app factory
│   ├── db/
│   │   └── database.ts           — sql.js setup, schema, repository
│   ├── routes/
│   │   ├── events.ts             — POST /events/booking-completed
│   │   ├── settlements.ts        — GET /settlements/:bookingId
│   │   └── health.ts             — GET /health
│   ├── services/
│   │   ├── settlementService.ts  — Core orchestration logic
│   │   ├── chargeCalculator.ts   — Pure charge computation
│   │   └── gatewayClient.ts      — HTTP client with retry
│   ├── middleware/
│   │   └── index.ts              — Trace ID injection, error handler
│   └── utils/
│       ├── logger.ts             — Pino structured logger
│       ├── retry.ts              — Exponential backoff + full jitter
│       └── validation.ts         — Zod schemas
├── mock-gateway/
│   └── index.ts                  — Flaky payment gateway mock
├── tests/
│   ├── chargeCalculator.test.ts  — 13 unit tests for charge logic
│   └── idempotency.test.ts       — 8 tests proving idempotency guarantee
├── docker-compose.yml
├── Dockerfile.service
├── Dockerfile.gateway
├── tsconfig.json
└── README.md
```

---

## Test Suite

```
 ✓ tests/idempotency.test.ts      (8 tests)
 ✓ tests/chargeCalculator.test.ts (13 tests)
 ─────────────────────────────────────────────
 21 tests, 0 failures
```

Key tests:
- **"charges the card EXACTLY ONCE when submitted 10 times"** — the primary idempotency proof
- **"returns alreadyProcessed=true on all duplicates"** — verifies response contract
- **"settlement breakdown is immutable across retries"** — charge rows never mutate
- **Charge edge cases**: on-time return, early return, 1-second-late (ceil behavior), exact-hour, zero values, large overages, negative input validation

---

## Environment Variables

| Variable              | Default                  | Description                        |
|-----------------------|--------------------------|------------------------------------|
| `PORT`                | `3000`                   | Settlement service HTTP port       |
| `GATEWAY_URL`         | `http://localhost:3001`  | Payment gateway base URL           |
| `GATEWAY_TIMEOUT_MS`  | `5000`                   | Per-attempt timeout in ms          |
| `DB_PATH`             | `./data/settlements.db`  | SQLite file location               |
| `LOG_LEVEL`           | `info`                   | Pino log level                     |
| `GATEWAY_PORT`        | `3001`                   | Mock gateway HTTP port             |
| `GATEWAY_FAILURE_RATE`| `0.15`                   | Gateway failure probability (0–1)  |

---

## Tradeoffs & Scope Cuts

| Cut | Reason | Production approach |
|-----|--------|---------------------|
| Logged event emission | No message broker available | Publish `BookingSettled` to Kafka/SNS/EventBridge |
| sql.js flush interval | sql.js is in-memory; flush every 2s | Postgres with pgBouncer for multi-replica |
| No auth on endpoints | Out of scope | JWT/mTLS verifying the upstream caller's identity |
| Single-node lock | `processing_locks` table works for one process | Redis Redlock for multi-replica deployments |
| No rate limiting | Out of scope | express-rate-limit or API gateway policy |
| No DLQ | Out of scope | Failed settlements → SQS DLQ for manual retry |

---

## What I'd Do With More Time

1. **Observability**: OpenTelemetry traces → Jaeger; metrics (settlement rate, gateway error rate, p99 capture latency) → Prometheus/Grafana
2. **Dead-letter queue**: `status=failed` settlements auto-enqueued for ops retry with exponential backoff
3. **Pre-auth validation service**: Verify `preAuthId` is live and sufficient before computing charge
4. **Settlement webhook**: POST `BookingSettled` back to the booking service asynchronously
5. **Admin API**: `GET /settlements?status=failed&userId=x&from=2026-01-01` with cursor pagination
6. **Proper DB migrations**: `db-migrate` or `flyway` with versioned migration files and rollback support
7. **Multi-replica safety**: Replace DB advisory lock with Redis Redlock; add optimistic concurrency control on settlement rows

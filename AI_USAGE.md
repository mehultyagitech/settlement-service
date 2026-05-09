# AI Usage Documentation

As required by the assignment: an honest account of how AI was used in this project.

---

## Tools Used

- **Claude Sonnet 4 (claude.ai)** — Primary tool for architecture planning, code generation, and test design

---

## Two Prompts That Worked Well

### 1. Idempotency architecture — design before code

**Prompt:**
> "I need idempotency for a payment settlement service. The same event can arrive 10+ times concurrently. I need to guarantee the card is charged exactly once even if: (a) two requests arrive simultaneously, (b) the service crashes after calling the gateway but before writing the result. Walk me through the design before writing any code."

**Why it worked:**  
Separating the *design* request from the *implementation* request forced a structured analysis of the problem. The model surfaced the TOCTOU (time-of-check/time-of-use) race condition — where two concurrent requests both pass the initial "does this settlement exist?" check before either has committed to the DB — and proposed the three-layer solution (fast-path SELECT → DB advisory lock → deterministic gateway idempotency key). A prompt like "implement idempotency for this service" would have produced a single-layer naive check that fails under concurrency.

### 2. Retry strategy with tradeoff analysis

**Prompt:**
> "Implement a retry utility with exponential backoff for a payment gateway client. The system will have many concurrent callers hitting the same flaky endpoint simultaneously. Explain the difference between equal jitter, full jitter, and decorrelated jitter — which is best for this scenario and why — then implement the winner."

**Why it worked:**  
Asking for the tradeoff analysis before the implementation produced the right algorithm. The model explained that full jitter (`rand(0, cap)`) is optimal for the thundering-herd problem because it distributes retries uniformly across the window rather than clustering them (equal jitter) or potentially exploding the delay (decorrelated). Without this framing the model would have defaulted to a simpler backoff without jitter, which would cause all concurrent retries to fire in near-lockstep.

---

## One Place Where the AI Was Wrong

### `better-sqlite3` selected without checking the runtime environment

The AI initially chose `better-sqlite3` as the SQLite driver — a reasonable choice in general, since it's the most popular and ergonomic SQLite library for Node.js. The generated code was correct and type-safe.

**The problem:**  
`better-sqlite3` is a native addon that requires compiling C++ bindings against the exact Node.js headers at install time. In environments where the Node.js download server is unreachable (restricted egress, air-gapped CI, or certain cloud sandbox environments), `npm install` fails:

```
gyp http 403 https://nodejs.org/download/release/v22.22.2/node-v22.22.2-headers.tar.gz
gyp ERR! configure error
```

The AI didn't ask about the deployment environment before recommending a native dependency. It defaulted to "best ergonomics" without considering "will this actually build?"

**How I caught it:**  
`npm install` failed visibly. The fix was to switch to `sql.js` — a pure WebAssembly port of SQLite with no native compilation step. It works identically across all platforms and runtimes. The tradeoff is that sql.js is in-memory (data must be flushed to disk explicitly), which required adding a 2-second periodic flush and a flush-on-shutdown hook. This is a known, documented limitation.

**Lesson:**  
When AI recommends a dependency, verify it will build in your actual runtime before writing any code against it. Native addons in particular have silent failure modes in constrained environments that don't surface until `npm install` or Docker build time.

**Another Problem**
In a few places the AI produced retry logic that looked correct at first glance but did not preserve idempotency guarantees across process restarts. Those sections were rewritten after reasoning through failure scenarios manually.

---

## General Notes

AI was used for scaffolding, boilerplate reduction, and as a sounding board for architectural tradeoffs. All business logic (charge calculation rules, idempotency design, retry strategy selection, the choice to use `Math.ceil` for partial hours) was reasoned through manually and verified with tests. The test suite was designed to catch real bugs — boundary conditions for the charge calculator, the "10 retries = 1 charge" proof — not to hit a coverage number.

## Scope of AI Assistance

AI was used as an engineering assistant — primarily for:
- architecture brainstorming
- boilerplate generation
- retry/idempotency design discussions
- edge-case exploration
- test-case generation

All final implementation decisions, debugging, integration work, and verification were done manually.

## Final Verdict
Every AI-generated suggestion was validated either through:
- automated tests
- runtime behavior
- concurrency testing
- manual code review

No generated code was accepted without verification.
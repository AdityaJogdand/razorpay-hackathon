# Build Phases — AI Recovery Agent (v2: Agentic Pivot)

## Phase 1: Foundation (Day 1-2) [DONE]
**Goal:** Repo structure, infra, DB schema, and a single request flowing end-to-end.

- [x] Create monorepo structure (backend/*, frontend, data, docker, docs)
- [x] docker-compose with PostgreSQL
- [x] FastAPI skeleton with health check
- [x] SQLAlchemy models + Alembic migrations for all tables
- [x] React app scaffold (Vite + routing shell + Ant Design)
- [x] Research Razorpay + NPCI decline codes, build taxonomy (153 codes)
- [x] Synthetic data generator (2000 txns, frozen)

---

## Phase 2: Pipeline Core (Day 3-5) [DONE]
**Goal:** Ingest -> classify -> plan -> persist -> audit, end-to-end.

- [x] F1: Webhook ingest endpoint (HMAC verify, dedup)
- [x] F2: Normalization layer (raw code -> taxonomy)
- [x] F3: Rules-based triage engine (153 codes mapped)
- [x] F3: Ollama integration for unmapped tail
- [x] F4: Deterministic policy engine (pure function)
- [x] F7: Stopping rules (6+ rules, versioned)
- [x] F9: Hash-chained audit ledger (verified working)
- [x] Config + kill switch routes

---

## Phase 3: AI Agent + Execution (Day 6-8) [NEXT]
**Goal:** LLM agent reasons about each failure, guardrails validate, execution runs.

### 3a. AI Recovery Agent
- [ ] Agent prompt engineering: system prompt with taxonomy context,
      customer context injection, structured JSON output with reasoning field
- [ ] Agent service: takes failure event + customer context -> returns
      structured RecoveryPlan with natural-language reasoning
- [ ] Agent email drafting: personalized re-auth emails for HARD/MANDATE
- [ ] Agent caching: cache by context hash for batch evaluation
- [ ] Fallback: if agent is unavailable/slow, fall back to rules-only engine

### 3b. Guardrail Engine
- [ ] Refactor policy engine into guardrail validator:
      takes agent-proposed plan, validates against stopping rules,
      overrides unsafe proposals, logs overrides
- [ ] Agent-guardrail agreement tracking (how often agent proposes safe plans)

### 3c. Execution Layer
- [ ] F8: Durable execution (persist before execute, idempotency keys)
- [ ] F8: Simulated gateway (returns outcomes from ground-truth surface)
- [ ] F8: Timeout handling (unresolved-unknown, reconciliation)
- [ ] Gmail SMTP for re-auth outreach (plus-addressed variants)
- [ ] N4: Kill switch (config flag + dashboard toggle, halts execution only)

### 3d. Models (supporting signal for agent)
- [ ] F5: Logistic regression for retry timing — agent uses as input
- [ ] F6: Single-model uplift estimator — agent uses as input

**Exit criteria:** POST a failure event -> agent reasons about it -> guardrails
validate -> execution runs -> outcome recorded. Agent reasoning visible in
audit ledger. Emails sent. Kill switch works. Agent-guardrail override logged
at least once in test data.

---

## Phase 4: Measurement (Day 9-10)
**Goal:** OPE evaluation with defensible numbers.

- [ ] Stochastic baseline policy (0.85 retry prob, 0.7 contact prob,
      logged propensities)
- [ ] Run baseline over held-out 800-txn batch, log all propensities
- [ ] Run agent policy over same batch (batch mode with caching)
- [ ] F10: IPS estimator with confidence intervals
- [ ] F10: Doubly Robust estimator with confidence intervals
- [ ] Agent-guardrail agreement rate metric
- [ ] Measurement report: rupees recovered, wasted attempts eliminated,
      contacts suppressed — each with CIs, vs baseline

**Exit criteria:** Can report: "Agent caused Rs X incremental recovery [95% CI]
vs baseline. Eliminated Z wasted attempts. Suppressed W unnecessary contacts.
Agent-guardrail agreement: N%."

---

## Phase 5: Dashboard (Day 10-11)
**Goal:** React dashboard with five views.

- [ ] View 1: Batch summary — OPE results front and centre,
      rupees recovered, attempts saved, contacts suppressed
- [ ] View 2: Agent decision trace — click into any transaction, see
      agent's reasoning, guardrail validation, classification, outcome
- [ ] View 3: Exception queue — UNKNOWN cases with agent's explanation
- [ ] View 4: Stopping-rule audit — rules fired, overrides, frequency
- [ ] View 5: Email outreach — sent/suppressed, agent-drafted content
- [ ] Kill switch toggle in header with status indicator
- [ ] "Verify Ledger Integrity" button
- [ ] Agent reasoning display (the "aha" demo moment)

**Exit criteria:** All five views render real data. Agent reasoning readable.
Kill switch toggleable. Ledger verification visual.

---

## Phase 6: Polish + Deliverables (Day 11-12)
**Goal:** Demo-ready, all deliverables complete.

- [ ] End-to-end smoke test (agent -> guardrail -> execute -> measure)
- [ ] README with architecture diagram (Agent + Guardrails + Execution)
- [ ] Measurement report document
- [ ] Honest limitations section
- [ ] Demo video — structured per PRD section 10:
      1. Problem statement (Stripe $8.2B claim)
      2. Agent reasoning on single transaction (aha moment)
      3. Guardrail catching unsafe proposal (trust moment)
      4. Batch OPE results (the number)
      5. Suppression counts (the insight)
      6. Close with headline delta + CI
- [ ] Pitch deck
- [ ] Final cleanup

**Exit criteria:** A stranger can clone the repo, start Postgres + Ollama,
and see the agent reason about a payment failure in under 5 minutes.

---

## Critical Path

```
Phase 1 (foundation) ──► Phase 2 (pipeline) ──► Phase 3 (AGENT + execute)
     [DONE]                  [DONE]                      |
                                                  Phase 4 (measurement)
                                                         |
                                                  Phase 5 (dashboard)
                                                         |
                                                  Phase 6 (polish)
```

**Phase 3 is now the centrepiece.** The agent reasoning is the demo moment.
Phase 4 (measurement) is the differentiator. Protect both.
If time is tight, compress Phase 5 before compressing Phase 3 or Phase 4.

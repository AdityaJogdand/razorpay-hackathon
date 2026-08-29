# PRD — AI Recovery Agent

**Track:** Razorpay Track 03 — AI Revenue Recovery
**Deadline:** 5 September 2026
**Status:** v2 — Agentic pivot

---

## 1. Thesis

Every payment recovery tool in the market — Stripe Smart Retries, Recurly Intelligent Retries, Chargebee Smart Dunning — is a black box that claims credit for revenue that would have recovered naturally. Stripe says "$8.2B recovered" but cannot answer: "how much of that would have been recovered by a dumb fixed-cadence retry?"

We build the opposite: an **AI agent that reasons about each failure, decides the recovery strategy, explains its reasoning in natural language, and then proves its incremental value with counterfactual measurement.**

The agent is the brain. A deterministic policy engine is the guardrail. The LLM reasons and plans; the rules enforce safety. Neither works alone.

**One-line pitch:** *An AI agent that recovers failed payments and proves exactly how much money it actually saved you.*

---

## 2. Why this wins the track

The track's stated bar: *"Don't just identify the problem. Show measured money recovered across a batch, with compliant escalation, stopping rules, and an audit trail."*

The buildathon judges also want: *"If your project touches agents, RAG, or LLM orchestration, make sure that's the part of the demo you spend the most time on — it's the whole point of the track."*

| Track requirement | How we satisfy it |
|---|---|
| **AI agent at the centre** | LLM reasons about every failure: reads the decline code, customer history, and payment context; produces a structured recovery strategy with natural-language explanation; the agent is the orchestration layer, not an afterthought |
| **Measured money across a batch** | Off-policy evaluation (IPS + Doubly Robust) with confidence intervals over an 800-transaction held-out batch, against a naive fixed-retry baseline |
| **Compliant escalation** | Agent decisions validated by deterministic guardrails; `UNKNOWN` and low-confidence cases route to human queue; zero unvalidated automated action |
| **Stopping rules** | Explicit, versioned constraint set enforced as guardrails around the agent; every non-action recorded as a `Suppression` with the rule that fired |
| **Audit trail** | Append-only, hash-chained decision ledger storing the agent's reasoning, the guardrail validation, and the execution outcome for every transaction |

**Anticipated competitive position.** Most Track 3 submissions will either (a) build "smarter retry" with basic if-else, or (b) wrap an LLM around retries without safety. Our differentiation:

1. **AI agent with guardrails** — the LLM reasons freely, but a deterministic engine validates every decision before execution. This is the architecture Razorpay engineers would actually trust.
2. **Agent reasoning is inspectable** — every decision comes with natural-language explanation stored in the audit trail. Not a black box.
3. **Counterfactual measurement** — we don't just say "we recovered ₹X." We say "₹X would have recovered anyway; our agent caused ₹Y of incremental recovery, with 95% CI [a, b]."
4. **Suppression as a feature** — the agent decides NOT to act on cases that would recover naturally, and we record and measure those non-actions.

---

## 3. Architecture: Agent + Guardrails

```
                    ┌─────────────────────────┐
                    │      AI Recovery Agent   │
                    │   (LLM: Ollama/Llama3.2) │
                    │                         │
                    │  - Reads failure context │
                    │  - Reasons about cause   │
                    │  - Proposes strategy     │
                    │  - Explains decision     │
                    │  - Drafts customer email │
                    └────────┬────────────────┘
                             │ Proposed RecoveryPlan
                             ▼
                    ┌─────────────────────────┐
                    │   Deterministic          │
                    │   Guardrail Engine       │
                    │                         │
                    │  - Validates class       │
                    │  - Enforces stopping     │
                    │    rules                 │
                    │  - Caps retries/contacts │
                    │  - Checks kill switch    │
                    │  - Rejects unsafe plans  │
                    └────────┬────────────────┘
                             │ Validated RecoveryPlan
                             ▼
                    ┌─────────────────────────┐
                    │   Execution Layer        │
                    │                         │
                    │  - Durable, idempotent  │
                    │  - Mock gateway          │
                    │  - Gmail SMTP outreach   │
                    │  - Audit ledger write    │
                    └─────────────────────────┘
```

**Key architectural constraint:** The LLM proposes. The guardrails validate. The execution layer acts. The LLM never directly triggers a money-moving call.

---

## 4. Non-goals

Explicitly out of scope. Binding for the build.

- **Fraud or risk scoring.** Track 2's territory.
- **Checkout abandonment recovery.** Different problem shape; dilutes thesis.
- **B2B receivables / invoice chasing.** Same reasoning.
- **Real PCI-scope card handling.** Tokens and metadata only.
- **Model retraining loop.** Documented but not implemented.
- **Voice recovery (Hinglish).** Cut entirely — the agent's reasoning ability is the demo, not a voice interface.
- **Card updater / network token refresh.** Network-level capability, cannot be replicated.

---

## 5. Users

**Primary: the merchant's finance/growth operator.** Wants to know how much revenue was recovered, what it cost in customer contacts, and which failures need human attention. Cares about the number, not the model.

**Secondary: the merchant's engineer.** Needs to trust that the AI agent cannot double-charge, cannot spam, and can be stopped instantly. Will look for guardrails, idempotency, and a kill switch. Wants to see the agent's reasoning to build trust.

**Tertiary: the compliance reviewer.** Needs any decision — including the agent's reasoning — reconstructible after the fact.

The dashboard serves the primary user. The agent reasoning trace and audit trail serve the other two.

---

## 6. Core requirements

### 6.1 Functional

**F1 — Ingest failure events.**
Accept webhook events for failed payments. Verify HMAC signature. Deduplicate on gateway event ID. Acknowledge fast, process asynchronously.

**F2 — Normalize to a canonical failure event.**
Map raw gateway and NPCI decline codes to an internal taxonomy (153 codes from Razorpay, NPCI UPI, and ISO 8583 sources). Preserve raw code for audit. Integer paise throughout.

**F3 — AI Agent triage and recovery planning.**
For each failure event, the AI agent:

1. **Reads the full context:** decline code, description, customer history (tenure, past failures, past successes, opt-out status), instrument type, amount, time of failure.
2. **Reasons about the failure:** Is the instrument dead? Is this transient? Is there a mandate issue? What's the likely root cause?
3. **Proposes a recovery strategy:** Retry timing, contact decision, escalation — with natural-language explanation of WHY.
4. **Drafts customer email** (for HARD/MANDATE cases): Personalized re-authorization request explaining what happened and what the customer needs to do.
5. **Outputs a structured RecoveryPlan:** JSON with classification, actions, suppressions, reasoning, and email draft.

The agent uses the decline code taxonomy as context (few-shot examples in the prompt) but reasons beyond it — handling ambiguous codes, edge cases, and multi-factor decisions that pure rules cannot.

**F4 — Guardrail validation.**
A deterministic engine validates every agent-proposed plan:

- Classification must be in {HARD, SOFT, MANDATE, UNKNOWN}
- HARD instruments must never be retried (override agent if it proposes retry)
- Retry count must respect config caps
- Contact must respect opt-out, contact caps, cooldown windows
- UNKNOWN must route to human queue (override agent if it proposes action)
- Kill switch check
- If guardrails reject a plan, the rejection is logged and the safe default is applied

**F5 — Decide retry timing (SOFT only).**
Agent proposes retry timing based on its reasoning about the failure context. A logistic regression model provides `P(success | context, retry_offset)` as supporting signal. Agent can accept or override the model's suggestion with explanation.

**F6 — Decide whether to contact (HARD / MANDATE).**
Agent reasons about whether outreach will help this specific customer. Single-model uplift estimator provides estimated incremental effect as input. Agent makes final contact/no-contact decision with explanation.

**F7 — Enforce stopping rules.**
Versioned, config-driven, enforced by the guardrail engine (not the agent). At minimum: never retry HARD; respect network attempt caps; cap cumulative contacts; expire after N days; honour opt-out; suppress on non-positive uplift.

**F8 — Execute durably and idempotently.**
Actions persisted before execution. Idempotency key derived from `(txn, action_type, scheduled_slot)`. Timeouts treated as unresolved-unknown and reconciled, never blindly retried. Simulated gateway with swappable interface.

**F9 — Record an immutable audit trail.**
Every agent reasoning, guardrail validation, plan, suppression, execution, and outcome appended to a hash-chained ledger. The agent's natural-language reasoning is stored as first-class audit data.

**F10 — Measure recovery against a baseline.**
Off-policy evaluation over held-out batch. Reports:
- Rupees recovered (agent vs baseline) with confidence intervals
- Wasted attempts eliminated
- Contacts suppressed
- Agent agreement rate with guardrails (how often the agent's plan passes validation unchanged)

Both IPS and Doubly Robust estimators.

**F11 — Present results.**
Dashboard with five views:
1. **Batch summary** — rupees recovered, attempts saved, contacts suppressed, OPE results front and centre
2. **Agent decision trace** — click into any transaction, see the agent's reasoning, guardrail validation, and outcome
3. **Exception queue** — UNKNOWN classifications awaiting human review, with agent's best-guess explanation
4. **Stopping-rule audit** — which rules fired, how often, what they overrode
5. **Email outreach** — sent/suppressed messages with agent-drafted content

### 6.2 Non-functional

**N1 — Agent proposes, guardrails dispose.** The LLM reasons and plans. The deterministic engine validates and enforces safety. The LLM never directly triggers execution. This is architectural, not a guideline.

**N2 — The guardrail engine is a pure function.** No I/O, no clock reads, no unseeded randomness. Same input plus same guardrail version yields the same validation result. This makes the audit trail reproducible.

**N3 — Fail closed.** Agent unavailable, model timeout, guardrail rejection — take no action and escalate. Never default to retrying.

**N4 — Kill switch.** A single flag halts all execution while leaving agent triage and planning live. Dashboard toggle + config flag.

**N5 — Multi-tenant schema.** Every table keyed by merchant. Budgets, caps, and rate limits scoped per merchant.

**N6 — Config over code.** Caps, thresholds, and budgets live in versioned config rows in Postgres. No deploy required to change policy.

---

## 7. Success metrics

The demo succeeds if it can report all of the following on a held-out batch:

| Metric | Baseline (fixed retry) | Target (agent) |
|---|---|---|
| Rupees recovered | reference | measurably higher, CI excluding zero |
| Wasted attempts on dead instruments | high | approximately zero |
| Contacts sent per recovery | all failures contacted | materially reduced via agent reasoning |
| Decisions requiring human review | n/a | reported honestly, not minimized |
| Agent-guardrail agreement | n/a | reported — shows agent learns the rules |

**The headline number is the OPE-estimated rupee delta with a confidence interval.** Everything else supports it.

**The demo moment is the agent reasoning trace.** Click into a failed payment, see the agent explain: "This is an expired card (code 54). The customer has been subscribed for 14 months with 0 past failures. I recommend a re-authorization email rather than retry because the instrument is permanently dead. Here is the draft email I would send." That is what wins an AI Buildathon.

---

## 8. Key risks

**R1 — Degenerate off-policy evaluation.** If the baseline is deterministic, IPS blows up. *Mitigation:* stochastic baseline with logged propensities. Day-one requirement.

**R2 — Fabricated decline taxonomy.** *Mitigation:* built from published Razorpay + NPCI + ISO 8583 codes. Already done and cited. [RESOLVED]

**R3 — Synthetic data circularity.** *Mitigation:* ground-truth surface frozen from industry patterns before policy code. Already done. [RESOLVED]

**R4 — Agent hallucination.** The LLM might propose dangerous actions (retry a dead card, spam a customer). *Mitigation:* the guardrail engine validates every plan. The agent cannot bypass guardrails. Unsafe proposals are logged as overrides — this is actually a good demo moment.

**R5 — Agent latency.** Ollama on local hardware may be slow, making batch processing painful. *Mitigation:* batch the agent calls, cache responses for identical decline code + context combinations, and fall back to rules-only mode if the agent is too slow.

**R6 — "Just an LLM wrapper" perception.** Judges may dismiss the project as "you just prompted an LLM." *Mitigation:* the guardrail architecture, the OPE measurement, and the suppression recording are the substance. The agent is the interface to that substance, not a thin wrapper.

**R7 — Timeout semantics.** A gateway timeout is not a failure. *Mitigation:* explicit unresolved state and reconciliation path.

---

## 9. Open questions

[RESOLVED] Decline taxonomy — built from published sources, 153 codes mapped.
[RESOLVED] Team size — solo build, full scope with AI assistance.
[RESOLVED] Synthetic data — 2000 transactions generated and frozen.

- Agent prompt engineering: How structured should the agent's output be? Fully JSON-structured, or free-form reasoning with structured extraction? *Lean toward structured JSON output with a `reasoning` field.*
- Agent caching: For the batch evaluation, should we cache agent responses by (decline_code, failure_class) to avoid 2000 LLM calls? *Yes — cache by context hash, with cache invalidation on prompt version change.*

---

## 10. Deliverables

1. Running system with AI agent, demonstrable end to end.
2. Public GitHub repository with README, architecture notes, and reproduction instructions.
3. Measurement report: OPE results with methodology, including propensity logging design.
4. Demo video and pitch deck — leading with (a) agent reasoning trace, (b) rupee delta.
5. Honest limitations section covering synthetic data, agent reliability, and what production deployment would additionally require.

**Demo narrative structure:**
1. Open with the problem: "Stripe says $8.2B recovered. How much was actually incremental?"
2. Show the agent reasoning on a single transaction — the "aha" moment
3. Show the guardrail catching an unsafe agent proposal — trust moment
4. Show the batch results with OPE — the measured money
5. Show suppression counts — "247 customers NOT contacted because the agent determined they'd pay anyway"
6. Close with the number: "Agent caused ₹X incremental recovery [95% CI], while sending 60% fewer messages than the baseline"

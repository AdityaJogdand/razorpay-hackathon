# Razorpay Payment Recovery Agent

An autonomous AI-powered payment recovery system that uses an LLM agent to reason about failed payments, deterministic guardrails to validate every action, and a real-time dashboard to monitor the entire pipeline.

Built for the Razorpay hackathon — covering the full lifecycle from payment failure ingestion to recovery execution, with off-policy evaluation to measure impact.

---

## Tech Stack

![Python](https://img.shields.io/badge/Python-3.10+-3776AB?style=for-the-badge&logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-0.141-009688?style=for-the-badge&logo=fastapi&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?style=for-the-badge&logo=postgresql&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?style=for-the-badge&logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-8.2-646CFF?style=for-the-badge&logo=vite&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-4.3-06B6D4?style=for-the-badge&logo=tailwindcss&logoColor=white)
![Ant Design](https://img.shields.io/badge/Ant_Design-6.6-0170FE?style=for-the-badge&logo=antdesign&logoColor=white)
![SQLAlchemy](https://img.shields.io/badge/SQLAlchemy-2.0-D71F00?style=for-the-badge&logo=sqlalchemy&logoColor=white)
![Ollama](https://img.shields.io/badge/Ollama-Llama_3.2-000000?style=for-the-badge&logo=ollama&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?style=for-the-badge&logo=docker&logoColor=white)
![scikit-learn](https://img.shields.io/badge/scikit--learn-1.9-F7931E?style=for-the-badge&logo=scikitlearn&logoColor=white)
![Pydantic](https://img.shields.io/badge/Pydantic-2.13-E92063?style=for-the-badge&logo=pydantic&logoColor=white)
![ElevenLabs](https://img.shields.io/badge/ElevenLabs-TTS-000000?style=for-the-badge)
![Gmail SMTP](https://img.shields.io/badge/Gmail-SMTP-EA4335?style=for-the-badge&logo=gmail&logoColor=white)
![Recharts](https://img.shields.io/badge/Recharts-3.10-22B5BF?style=for-the-badge)
![Alembic](https://img.shields.io/badge/Alembic-1.19-6BA81E?style=for-the-badge)

| Layer | Technology |
|-------|-----------|
| Backend | Python 3.10+, FastAPI 0.141, SQLAlchemy 2.0, Alembic 1.19, Pydantic 2.13 |
| Frontend | React 19, TypeScript 6.0, Vite 8.2, Ant Design 6.6, Tailwind CSS 4.3, Recharts 3.10 |
| Database | PostgreSQL 16 (Docker, port 5434), asyncpg, psycopg2 |
| ML/Stats | scikit-learn 1.9, NumPy 2.5, Pandas 3.0, SciPy 1.18 |
| LLM | Ollama (Llama 3.2) — fully local inference, no cloud dependency |
| Voice TTS | ElevenLabs API (eleven_v3) |
| Email | Gmail SMTP with app passwords |

---

## Key Metrics

| Metric | Value |
|--------|-------|
| API Endpoints | **45** across 13 modules |
| Decline Codes | **153+** mapped from Razorpay, NPCI, ISO 8583, Visa/Mastercard |
| Guardrail Rules | **12** deterministic compliance rules |
| Database Tables | **8** with hash-chained audit ledger |
| Dashboard Pages | **12** interactive views |
| Synthetic Transactions | **2,000** (1,200 dev + 800 holdout) |
| Failure Classes | **4** (SOFT, HARD, MANDATE, UNKNOWN) |
| Recovery Channels | **5** (retry, email, mandate, checkout, voice) |

---

## Architecture

```
Webhook --> Ingest --> Classify --> Agent Reasons --> Guardrail Validates --> Execute --> Ledger
                                       |                    |                   |
                                  Proposes action     12 safety rules     Idempotent,
                                  with reasoning      override logged     kill-switch aware
```

**Key principle:** The LLM proposes, deterministic rules validate, and the agent never executes directly. Every decision is logged in a hash-chained audit ledger.

---

## Off-Policy Evaluation (OPE)

The system measures agent impact using causal inference on an 800-transaction holdout set, comparing the AI agent against a stochastic baseline policy.

### Estimators

| Estimator | Method | Purpose |
|-----------|--------|---------|
| **IPS** (Inverse Propensity Scoring) | Weights outcomes by baseline propensity scores | Unbiased when baseline is stochastic |
| **Doubly Robust** | Blends IPS with direct model estimate using ground truth | ~30% variance reduction over IPS |

### Metrics Computed

| Metric | Description |
|--------|-------------|
| `agent_recovery_rate` | % of transactions recovered by the AI agent |
| `baseline_recovery_rate` | % recovered by the fixed-retry baseline policy |
| `incremental_recovery_paise` | Net revenue lift (agent minus baseline) in paise |
| `ci_lower_paise` / `ci_upper_paise` | 95% confidence interval bounds on incremental revenue |
| `agreement_rate` | Agent-guardrail alignment (% of proposals approved unchanged) |
| `attempts_saved` | Baseline retries minus agent retries |
| `contacts_suppressed` | Baseline outreach minus agent outreach |
| `avg_time_to_recovery` | Mean hours to first successful recovery (agent vs. baseline) |
| `by_class` breakdown | Per-class (SOFT/HARD/MANDATE/UNKNOWN) recovery rates |

### Evaluation Design

- **Baseline policy:** Stochastic — 0.85 retry probability, 0.70 contact probability (logged propensities prevent IPS degeneracy)
- **Baseline retry schedule:** retry 1 at 2h, retry 2 at 24h, retry 3 at 48h
- **Agent retry schedule:** retry 1 at 6h, retry 2 at 24h, retry 3 at 48h
- **Ground truth:** Frozen in `data/synthetic_dataset.json` before any policy code was written (prevents circularity — PRD R3)
- **Confidence intervals:** Normal approximation at 95% level
- **Endpoint:** `GET /ope/evaluate?method=ips|dr&split=dev|holdout`

---

## Features

### Recovery Channels
- **Smart Retry** — Agent-driven retry scheduling with gateway simulation (~67% success rate)
- **Email Outreach** — LLM-generated personalized emails with human approval workflow (Gmail SMTP)
- **Mandate Sequencer** — NPCI-compliant multi-step mandate recovery (5 sub-types, up to 7 steps per sequence)
- **Checkout Recovery** — Abandoned checkout funnel tracking with timed recovery emails (1h, 24h, 72h)
- **Voice Recovery** — Hinglish call script generation (Ollama) + ElevenLabs TTS synthesis + promise-to-pay tracking

### Safety & Audit
- **Guardrail Engine** — 12 deterministic rules including RBI compliance, card network limits, contact frequency caps
- **SHACL Validation** — RDF/OWL ontology with Turtle shape graphs for semantic validation
- **Hash-Chained Ledger** — Append-only audit trail with SHA-256 integrity verification
- **Kill Switch** — Instant halt of all automated actions via dashboard toggle
- **Exception Queue** — Manual review workflow for escalated/unknown cases

### Measurement
- **Off-Policy Evaluation** — IPS and Doubly Robust estimators comparing agent vs. baseline policy
- **Holdout Testing** — 800 held-out transactions for unbiased evaluation with 95% confidence intervals
- **Payment Simulator** — Interactive simulation hub for testing all failure types

---

## Guardrail Rules

| # | Rule | Regulation |
|---|------|------------|
| 1 | **hard_no_retry** — HARD declines must never be retried | Visa/Mastercard Core Rules 2024 |
| 2 | **mandate_no_retry** — MANDATE failures must never be retried | RBI e-Mandate Framework DPSS.CO.PD.No.629 |
| 3 | **max_retry_count** — Retry count must not exceed configured max | Visa 15/30d, Mastercard 10-25/30d, NPCI UPI 5/txn |
| 4 | **retry_window** — All retries within the retry window | Visa/Mastercard 30-day, NPCI UPI 48h |
| 5 | **contact_frequency_cap** — Contact count must not exceed max | RBI Digital Lending Guidelines RBI/DOR/2022-23/145 |
| 6 | **customer_opt_out** — Opted-out customers must never be contacted | RBI/DBR/2017-18/15, IT Act 2000 S43A |
| 7 | **no_email_on_file** — Cannot email if no address on file | RBI Digital Lending Guidelines |
| 8 | **unknown_must_escalate** — UNKNOWN with low confidence must escalate | RBI Operational Risk Management Framework |
| 9 | **kill_switch** — Kill switch halts all automated execution | RBI Business Continuity Planning |
| 10 | **email_no_internal_ids** — Email must not contain internal identifiers | Auto-scrubbed |
| 11 | **email_no_technical_jargon** — Email must not contain technical terms | Auto-removed |
| 12 | **email_min_content** — Email body must have minimum 50 characters | Quality check |

---

## Database Schema

| Table | Purpose |
|-------|---------|
| `failure_events` | Payment failures with normalized classification |
| `recovery_plans` | Policy engine output for each failure |
| `actions` | Executed or scheduled recovery actions |
| `suppressions` | Guardrail overrides and suppression log |
| `audit_ledger` | Hash-chained immutable audit trail (SHA-256) |
| `exception_resolutions` | Human review outcomes for UNKNOWN cases |
| `config_versions` | Versioned merchant recovery policies |

**Enums:** FailureClass (SOFT/HARD/MANDATE/UNKNOWN), ActionType (RETRY/CONTACT_EMAIL/REAUTH_REQUEST/ESCALATE_HUMAN), ActionStatus (8 states), LedgerEventType (8 event types)

---

## Quick Start

### Prerequisites

- Python 3.10+
- Node.js 18+
- Docker & Docker Compose
- [Ollama](https://ollama.ai) with `llama3.2` model pulled

### 1. Clone and set up environment

```bash
git clone <repo-url>
cd Razorpay-hackathon

# Python virtual environment
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### 2. Configure environment variables

Create a `.env` file in the project root:

```env
# Database
DATABASE_URL=postgresql+asyncpg://recovery:recovery_dev_pass@localhost:5434/recovery_agent
DATABASE_URL_SYNC=postgresql+psycopg2://recovery:recovery_dev_pass@localhost:5434/recovery_agent

# Security
WEBHOOK_SECRET=whsec_test_secret_key_for_dev
API_KEY=dev_api_key_change_in_production

# LLM (local Ollama)
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3.2

# Email (optional — falls back to mock)
GMAIL_USER=your_email@gmail.com
GMAIL_APP_PASSWORD=your_app_password

# Voice TTS (optional)
ELEVENLABS_API_KEY=your_elevenlabs_key

# Kill Switch
KILL_SWITCH=false
```

### 3. Start the database

```bash
cd docker
docker-compose up -d
cd ..
```

### 4. Run database migrations

```bash
alembic upgrade head
```

### 5. Start Ollama

```bash
ollama pull llama3.2
ollama serve
```

### 6. Start the backend

```bash
uvicorn backend.main:app --reload --port 8000
```

### 7. Start the frontend

```bash
cd frontend
npm install
npm run dev
```

The dashboard is now available at **http://localhost:5173**

---

## Project Structure

```
.
├── backend/
│   ├── agent/          # LLM reasoning engine (Ollama)
│   ├── guardrail/      # Deterministic safety rules + SHACL
│   ├── execution/      # Action execution (retry, email, escalate)
│   ├── ingest/         # Webhook ingestion & dedup
│   ├── classifier/     # Failure classification (SOFT/HARD/MANDATE/UNKNOWN)
│   ├── dashboard/      # REST API for frontend
│   ├── ledger/         # Hash-chained audit trail
│   ├── ope/            # Off-policy evaluation (IPS, Doubly Robust)
│   ├── config/         # Versioned merchant config & kill switch
│   ├── simulate/       # Payment gateway simulation
│   ├── mandate/        # NPCI mandate sequencer
│   ├── checkout/       # Checkout abandonment recovery
│   ├── voice/          # Hinglish voice scripts + ElevenLabs TTS
│   ├── subscription/   # Recurring failure detection & recovery
│   ├── models/         # SQLAlchemy tables & enums
│   ├── core/           # Database, config, security
│   └── main.py         # FastAPI app entrypoint
├── frontend/
│   └── src/
│       ├── pages/      # 12 dashboard views
│       ├── layout/     # AppLayout with sidebar
│       ├── api/        # API client & service functions
│       └── assets/     # Static assets
├── alembic/            # Database migration scripts
├── data/               # Synthetic dataset generator (~2000 txns)
├── docker/             # Docker Compose (PostgreSQL)
├── docs/               # Documentation
└── tests/              # Test suite
```

---

## Dashboard Pages

| Page | Route | Description |
|------|-------|-------------|
| Batch Summary | `/dashboard` | OPE results, recovery KPIs, recovered amount, attempts saved |
| Decision Traces | `/trace` | Per-transaction agent reasoning, guardrail checks, execution outcomes |
| Exception Queue | `/exceptions` | Manual review queue for escalated cases |
| Mandate Sequencer | `/mandates` | Multi-step NPCI mandate recovery sequences |
| Checkout Recovery | `/checkout` | Abandoned checkout funnel with recovery emails |
| Voice Recovery | `/voice` | Hinglish script generation + TTS audio preview + promise-to-pay |
| Subscription Recovery | `/subscription` | Recurring failure detection and intervention recommendations |
| Guardrail Audit | `/rules` | Suppression log — what the guardrails blocked and why |
| Email Outreach | `/emails` | Email campaign tracking and outreach history |
| Audit Ledger | `/ledger` | Hash-chained ledger explorer with integrity verification |
| Simulation Hub | `/simulate` | Interactive payment failure simulation |
| Recovery Impact | `/impact` | Recovery impact analysis |

---

## API Endpoints (45 total)

### Core Pipeline
- `POST /ingest/webhook` — Ingest payment failure events
- `POST /ingest/batch` — Batch ingest multiple events
- `POST /agent/process/{event_id}` — Run full agent pipeline on a failure
- `POST /agent/batch-process` — Batch process multiple failures

### Agent Actions
- `PUT /agent/email-draft/{action_id}` — Edit email draft
- `POST /agent/approve-email/{action_id}` — Approve email for sending
- `POST /agent/deny-email/{action_id}` — Deny email draft

### Recovery Channels
- `POST /simulate/payment` — Simulate a payment failure
- `POST /simulate/recover/{id}` — Attempt gateway recovery
- `GET /simulate/decline-codes` — List available decline codes
- `GET /mandate/sequences` — List mandate recovery sequences
- `GET /mandate/sequence/{id}` — Get mandate sequence detail
- `POST /mandate/sequence/{id}` — Create mandate sequence
- `POST /mandate/advance/{id}` — Advance a mandate sequence step
- `GET /mandate/stats` — Mandate recovery statistics
- `POST /checkout/simulate` — Simulate checkout abandonment
- `GET /checkout/events` — List checkout events
- `GET /checkout/stats` — Checkout recovery statistics
- `GET /checkout/preview/{id}` — Preview recovery email
- `POST /checkout/recover/{id}` — Trigger checkout recovery
- `POST /checkout/complete/{id}` — Mark checkout as completed
- `POST /voice/generate-script/{event_id}` — Generate Hinglish call script
- `POST /voice/synthesize/{event_id}` — Synthesize audio via ElevenLabs TTS
- `GET /voice/voices` — List available TTS voices
- `POST /voice/promise/{id}` — Record promise-to-pay
- `GET /voice/promise/{id}` — Get promise-to-pay status
- `GET /voice/promises` — List all promises
- `GET /subscription/recurring-failures` — Detect recurring payment failures
- `POST /subscription/trigger/{id}` — Trigger subscription recovery

### Dashboard & Audit
- `GET /dashboard/events` — Paginated event list with agent/guardrail data
- `GET /dashboard/summary` — Aggregated KPIs
- `POST /dashboard/exceptions/{id}/resolve` — Resolve exception
- `GET /dashboard/exceptions/resolutions` — List resolutions
- `GET /ledger/recent` — Recent audit ledger entries
- `POST /ledger/verify` — Verify hash chain integrity
- `GET /ledger/entries/{id}` — Get ledger entries for entity
- `GET /ledger/count` — Total ledger entry count
- `GET /ope/evaluate` — Off-policy evaluation (IPS or Doubly Robust)
- `GET /execution/stats` — Execution statistics
- `GET /execution/actions/{id}` — Get actions for event

### Config & System
- `POST /config/kill-switch` — Toggle kill switch
- `GET /config/current` — Get current config
- `GET /guardrail/ontology` — SHACL ontology (RDF/OWL)
- `GET /guardrail/shapes` — SHACL shape graphs (Turtle)
- `GET /guardrail/info` — Guardrail rule descriptions
- `GET /health` — System health check

---

## Synthetic Data

The `data/` directory contains a generator for ~2,000 synthetic transactions:

- **Distribution:** 40% SOFT, 30% HARD, 15% MANDATE, 15% UNKNOWN
- **Decline codes:** 153+ codes sourced from Razorpay, NPCI, ISO 8583, Visa/Mastercard
- **Split:** 1,200 dev / 800 holdout for unbiased OPE evaluation
- **Baseline policy:** Stochastic (0.85 retry probability, 0.7 contact probability) with logged propensities
- **Ground truth:** Frozen before policy code to prevent circularity (PRD R3)

---

## How It Works

1. **Ingest** — Payment failure webhook arrives, gets deduplicated and normalized
2. **Classify** — Failure categorized as SOFT, HARD, MANDATE, or UNKNOWN using 153+ decline code taxonomy
3. **Agent Reasons** — LLM analyzes failure context, customer history, and proposes an action with reasoning
4. **Guardrail Validates** — 12 deterministic rules check the proposal (hard failures can't retry, contact caps, RBI compliance)
5. **Execute** — Approved action runs idempotently (retry via gateway, send email, escalate to human)
6. **Ledger** — Every step is hash-chained into the append-only audit trail (SHA-256)
7. **Measure** — OPE compares agent performance against baseline on 800-transaction holdout set with 95% CIs

---

## License

Hackathon project - Razorpay 2026

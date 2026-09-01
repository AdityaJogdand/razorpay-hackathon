# Razorpay Payment Recovery Agent

An autonomous AI-powered payment recovery system that uses an LLM agent to reason about failed payments, deterministic guardrails to validate every action, and a real-time dashboard to monitor the entire pipeline.

Built for the Razorpay hackathon — covering the full lifecycle from payment failure ingestion to recovery execution, with off-policy evaluation to measure impact.

---

## Architecture

```
Webhook --> Ingest --> Classify --> Agent Reasons --> Guardrail Validates --> Execute --> Ledger
                                       |                    |                   |
                                  Proposes action     9+ safety rules     Idempotent,
                                  with reasoning      override logged     kill-switch aware
```

**Key principle:** The LLM proposes, deterministic rules validate, and the agent never executes directly. Every decision is logged in a hash-chained audit ledger.

---

## Features

### Recovery Channels
- **Smart Retry** — Agent-driven retry scheduling with gateway simulation (~67% success rate)
- **Email Outreach** — LLM-generated personalized emails with human approval workflow (Gmail SMTP)
- **Mandate Sequencer** — NPCI-compliant multi-step mandate recovery (5 sub-types)
- **Checkout Recovery** — Abandoned checkout funnel tracking with timed recovery emails
- **Voice Recovery** — Hinglish call script generation (Ollama) + ElevenLabs TTS synthesis

### Safety & Audit
- **Guardrail Engine** — 12+ deterministic rules including RBI compliance, card network DNC lists, contact frequency caps
- **SHACL Validation** — RDF/OWL ontology with Turtle shape graphs for semantic validation
- **Hash-Chained Ledger** — Append-only audit trail with integrity verification (SHA-256)
- **Kill Switch** — Instant halt of all automated actions via dashboard toggle
- **Exception Queue** — Manual review workflow for escalated/unknown cases

### Measurement
- **Off-Policy Evaluation** — IPS and Doubly Robust estimators comparing agent vs. baseline policy
- **Holdout Testing** — 800 held-out transactions for unbiased evaluation with 95% confidence intervals
- **Payment Simulator** — Interactive simulation hub for testing all failure types

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Python, FastAPI, SQLAlchemy, Alembic |
| Frontend | React 19, TypeScript, Vite, Ant Design, Tailwind CSS, Recharts |
| Database | PostgreSQL 16 (Docker, port 5434) |
| LLM | Ollama (Llama 3.2) — local inference |
| Voice TTS | ElevenLabs API (eleven_v3) |
| Email | Gmail SMTP with app passwords |

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
│   ├── dashboard/      # REST API + WebSocket for frontend
│   ├── ledger/         # Hash-chained audit trail
│   ├── ope/            # Off-policy evaluation (IPS, Doubly Robust)
│   ├── config/         # Versioned merchant config & kill switch
│   ├── simulate/       # Payment gateway simulation
│   ├── mandate/        # NPCI mandate sequencer
│   ├── checkout/       # Checkout abandonment recovery
│   ├── voice/          # Hinglish voice scripts + ElevenLabs TTS
│   ├── models/         # SQLAlchemy tables & enums
│   ├── core/           # Database, config, security
│   └── main.py         # FastAPI app entrypoint
├── frontend/
│   └── src/
│       ├── pages/      # All dashboard views
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
| Decision Traces | `/trace` | Per-transaction agent reasoning, guardrail checks, and execution outcomes |
| Exception Queue | `/exceptions` | Manual review queue for escalated cases |
| Mandate Sequencer | `/mandates` | Multi-step NPCI mandate recovery sequences |
| Checkout Recovery | `/checkout` | Abandoned checkout funnel with recovery emails |
| Voice Recovery | `/voice` | Hinglish script generation + TTS audio preview |
| Guardrail Audit | `/rules` | Suppression log — what the guardrails blocked and why |
| Email Outreach | `/emails` | Email campaign tracking and outreach history |
| Audit Ledger | `/ledger` | Hash-chained ledger explorer with integrity verification |
| Simulation Hub | `/simulate` | Interactive payment failure simulation |

---

## API Endpoints

### Core Pipeline
- `POST /ingest/webhook` — Ingest payment failure events
- `POST /agent/process/{event_id}` — Run full agent pipeline on a failure
- `POST /agent/batch-process` — Batch process multiple failures

### Recovery Channels
- `POST /simulate/payment` — Simulate a payment failure
- `POST /simulate/recover/{id}` — Attempt gateway recovery
- `GET /mandate/sequences` — List mandate recovery sequences
- `POST /mandate/advance/{id}` — Advance a mandate sequence step
- `POST /checkout/abandon` — Record a checkout abandonment
- `POST /checkout/recover/{id}` — Trigger checkout recovery
- `POST /voice/generate-script/{event_id}` — Generate Hinglish call script
- `POST /voice/synthesize/{event_id}` — Synthesize audio via ElevenLabs TTS
- `GET /voice/voices` — List available TTS voices

### Dashboard & Audit
- `GET /dashboard/events` — Paginated event list with agent/guardrail data
- `GET /dashboard/summary` — Aggregated KPIs
- `GET /ledger/recent` — Recent audit ledger entries
- `POST /ledger/verify` — Verify hash chain integrity
- `GET /ope/evaluate` — Off-policy evaluation (IPS or Doubly Robust)

### Config
- `POST /config/kill-switch` — Toggle kill switch
- `GET /health` — System health check

---

## Synthetic Data

The `data/` directory contains a generator for ~2000 synthetic transactions:

- **Distribution:** 40% SOFT, 30% HARD, 15% MANDATE, 15% UNKNOWN
- **Decline codes:** 153+ codes sourced from Razorpay and NPCI published documentation
- **Split:** 1200 dev / 800 holdout for unbiased OPE evaluation
- **Baseline policy:** Stochastic (0.85 retry probability, 0.7 contact probability) with logged propensities

---

## How It Works

1. **Ingest** — Payment failure webhook arrives, gets deduplicated and normalized
2. **Classify** — Failure categorized as SOFT, HARD, MANDATE, or UNKNOWN using decline code taxonomy
3. **Agent Reasons** — LLM analyzes failure context, customer history, and proposes an action with reasoning
4. **Guardrail Validates** — 12+ deterministic rules check the proposal (hard failures can't retry, contact caps, RBI compliance)
5. **Execute** — Approved action runs idempotently (retry via gateway, send email, escalate to human)
6. **Ledger** — Every step is hash-chained into the append-only audit trail
7. **Measure** — OPE compares agent performance against baseline on holdout set

---

## License

Hackathon project - Razorpay 2026

"""
Payment Gateway Simulation — full lifecycle demo for all failure classes.

Endpoints:
  POST /simulate/payment      — simulate a failed payment (ingest + agent + execution)
  POST /simulate/recover/{id} — simulate customer responding and paying successfully
"""

import uuid
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.database import get_db
from backend.ingest.schemas import WebhookPayload
from backend.ingest.service import process_webhook
from backend.dashboard.ws import notify_dashboard_update
from backend.agent.router import process_with_agent
from backend.models.enums import ActionType, ActionStatus, LedgerEventType
from backend.models.tables import FailureEvent, Action
from backend.ledger.service import append as ledger_append
from backend.mandate.sequencer import classify_mandate_subtype, build_sequence

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/simulate", tags=["simulate"])

# ── Presets for each failure type ──
# Uses REAL taxonomy codes so classification works correctly

FAILURE_PRESETS = {
    "SOFT": {
        "error_code": "payment_failed_because_gateway_timeout",
        "error_description": "Payment failed due to gateway timeout. The issuing bank did not respond in time.",
        "instrument_type": "CARD",
    },
    "HARD": {
        "error_code": "payment_failed_because_card_expired",
        "error_description": "The card has expired. Customer must use a different payment method.",
        "instrument_type": "CARD",
    },
    "UNKNOWN": {
        "error_code": "payment_failed_because_do_not_honor",
        "error_description": "An unrecognized error occurred during payment processing.",
        "instrument_type": "UPI",
    },
}

# MANDATE sub-type presets — each maps to a real NPCI code
MANDATE_PRESETS = {
    "NOT_FOUND": {
        "error_code": "U40",
        "error_description": "Mandate not found at payer PSP. No active mandate exists for this customer.",
        "instrument_type": "UPI",
    },
    "REVOKED": {
        "error_code": "U37",
        "error_description": "Mandate has been revoked by the customer. Re-authorization required.",
        "instrument_type": "UPI",
    },
    "PAUSED": {
        "error_code": "U38",
        "error_description": "Mandate is currently paused by the customer.",
        "instrument_type": "UPI",
    },
    "EXPIRED": {
        "error_code": "U39",
        "error_description": "Mandate has expired. A new mandate must be registered.",
        "instrument_type": "UPI",
    },
    "DEBIT_LIMIT": {
        "error_code": "U41",
        "error_description": "Mandate debit limit breached. Amount exceeds the mandate cap.",
        "instrument_type": "UPI",
    },
    "PRE_DEBIT": {
        "error_code": "U47",
        "error_description": "Pre-debit notification was not sent before mandate execution.",
        "instrument_type": "UPI",
    },
    "STOP_PAYMENT": {
        "error_code": "R0",
        "error_description": "Stop payment order placed by customer on recurring authorization.",
        "instrument_type": "CARD",
    },
}


class SimulatePaymentRequest(BaseModel):
    failure_type: str = Field(..., pattern="^(SOFT|HARD|MANDATE|UNKNOWN)$")
    mandate_sub_type: str | None = Field(default=None)
    amount_paise: int = Field(default=150000, gt=0, le=10000000)
    customer_email: str = Field(default="demo@razorpay.com")
    merchant_id: str = Field(default="merchant_demo_001")


@router.post("/payment")
async def simulate_payment(
    body: SimulatePaymentRequest,
    db: AsyncSession = Depends(get_db),
):
    """
    Simulate a failed payment — full lifecycle.

    1. Ingests the failure (classify + plan)
    2. Runs agent pipeline (reasoning + guardrail + execution)
    3. For MANDATE: auto-creates recovery sequence
    """
    # Pick preset
    if body.failure_type == "MANDATE":
        sub_key = body.mandate_sub_type or "NOT_FOUND"
        preset = MANDATE_PRESETS.get(sub_key, MANDATE_PRESETS["NOT_FOUND"])
    else:
        preset = FAILURE_PRESETS[body.failure_type]

    txn_id = f"pay_{uuid.uuid4().hex[:16]}"

    payload = WebhookPayload(
        gateway_event_id=f"evt_{uuid.uuid4().hex[:12]}",
        merchant_id=body.merchant_id,
        transaction_id=txn_id,
        subscription_id=f"sub_{uuid.uuid4().hex[:8]}",
        customer_id=f"cust_{uuid.uuid4().hex[:8]}",
        customer_email=body.customer_email,
        instrument_type=preset["instrument_type"],
        instrument_token=f"tok_{uuid.uuid4().hex[:12]}",
        error_code=preset["error_code"],
        error_description=preset["error_description"],
        amount_paise=body.amount_paise,
        currency="INR",
        failed_at=datetime.now(timezone.utc),
    )

    # Step 1: Ingest
    ingest_result = await process_webhook(db, payload)
    if ingest_result["message"] == "duplicate":
        raise HTTPException(status_code=409, detail="Duplicate event")

    event_id = ingest_result["event_id"]

    # Step 2: Agent pipeline
    agent_result = {}
    try:
        agent_result = await process_with_agent(event_id, db)
    except Exception as e:
        logger.warning(f"Agent pipeline failed for {event_id}: {e}")
        agent_result = {"error": str(e)}

    # Step 3: For MANDATE — auto-create recovery sequence
    mandate_sequence = None
    if body.failure_type == "MANDATE" or ingest_result.get("failure_class") == "MANDATE":
        try:
            event_uuid = uuid.UUID(event_id)
            result = await db.execute(
                select(FailureEvent).where(FailureEvent.id == event_uuid)
            )
            event = result.scalar_one_or_none()
            if event:
                sub_type = classify_mandate_subtype(event.raw_error_code, event.normalized_code)
                seq = build_sequence(sub_type, event.amount_paise, bool(event.customer_email))
                mandate_sequence = {
                    "sub_type": sub_type.value,
                    "retryable": seq.retryable,
                    "total_steps": len(seq.steps),
                    "description": seq.description,
                }
        except Exception as e:
            logger.warning(f"Mandate sequence lookup failed: {e}")

    await notify_dashboard_update("simulation")

    return {
        "simulation": {
            "transaction_id": txn_id,
            "failure_type": body.failure_type,
            "mandate_sub_type": body.mandate_sub_type if body.failure_type == "MANDATE" else None,
            "amount_paise": body.amount_paise,
            "amount_display": f"\u20B9{body.amount_paise / 100:,.2f}",
            "customer_email": body.customer_email,
            "error_code": preset["error_code"],
            "error_description": preset["error_description"],
        },
        "ingest": {
            "event_id": event_id,
            "failure_class": ingest_result["failure_class"],
            "classification_source": ingest_result["classification_source"],
            "confidence": ingest_result["classification_confidence"],
            "plan_summary": ingest_result["plan_summary"],
        },
        "agent": agent_result.get("agent", {}),
        "guardrail": agent_result.get("guardrail", {}),
        "execution": agent_result.get("execution", []),
        "mandate_sequence": mandate_sequence,
    }


@router.post("/recover/{event_id}")
async def simulate_recovery(
    event_id: str,
    db: AsyncSession = Depends(get_db),
):
    """
    Simulate customer responding to recovery email and paying successfully.

    This is the "happy path" completion:
    - Customer got the email (re-auth / card update / mandate renewal)
    - Customer updated their payment method
    - We retry the payment and it succeeds

    Creates a successful RETRY action on the event → marks it as recovered.
    """
    event_uuid = uuid.UUID(event_id)
    result = await db.execute(
        select(FailureEvent).where(FailureEvent.id == event_uuid)
    )
    event = result.scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    # Check if already recovered
    existing_actions = await db.execute(
        select(Action).where(
            Action.failure_event_id == event_uuid,
            Action.action_type == ActionType.RETRY,
            Action.status == ActionStatus.SUCCEEDED,
        )
    )
    if existing_actions.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Already recovered")

    now = datetime.now(timezone.utc)

    # Count existing retries
    retry_count_result = await db.execute(
        select(Action).where(
            Action.failure_event_id == event_uuid,
            Action.action_type == ActionType.RETRY,
        )
    )
    retry_count = len(list(retry_count_result.scalars().all()))

    # Create a successful retry action — simulates the payment going through
    action_row = Action(
        id=uuid.uuid4(),
        failure_event_id=event.id,
        recovery_plan_id=None,
        merchant_id=event.merchant_id,
        action_type=ActionType.RETRY,
        status=ActionStatus.SUCCEEDED,
        idempotency_key=f"{event.id}:RECOVERY_SIM:{uuid.uuid4().hex[:8]}",
        scheduled_at=now,
        executed_at=now,
        retry_number=retry_count + 1,
        outcome={
            "status": "captured",
            "payment_id": f"pay_recovered_{uuid.uuid4().hex[:12]}",
            "amount": event.amount_paise,
            "recovery_trigger": "customer_responded_to_email",
        },
    )
    db.add(action_row)
    await db.flush()

    # Audit log
    await ledger_append(
        db, event.merchant_id, LedgerEventType.ACTION_EXECUTED,
        event.id, "action",
        {
            "action_id": str(action_row.id),
            "action_type": "RETRY",
            "status": "SUCCEEDED",
            "outcome": action_row.outcome,
            "recovery_type": "simulated_customer_response",
        },
    )

    await db.commit()
    await notify_dashboard_update("payment_recovered")

    return {
        "event_id": str(event.id),
        "transaction_id": event.transaction_id,
        "amount_paise": event.amount_paise,
        "amount_display": f"\u20B9{event.amount_paise / 100:,.2f}",
        "status": "recovered",
        "payment_id": action_row.outcome["payment_id"],
        "failure_class": event.failure_class.value if event.failure_class else "UNKNOWN",
        "detail": "Customer responded to recovery outreach — payment successfully captured",
    }

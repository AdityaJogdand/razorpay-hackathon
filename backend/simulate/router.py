"""
Payment Gateway Simulation — full lifecycle demo for all failure classes.

Endpoints:
  POST /simulate/payment      — simulate a failed payment (ingest + agent + execution)
  POST /simulate/recover/{id} — simulate customer responding and paying successfully
"""

import hashlib
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

# ── Decline code catalog ──
# Curated list of real decline codes for simulation — the classifier determines the failure class

DECLINE_CODE_CATALOG = [
    # SOFT — transient
    {"code": "payment_failed_because_gateway_timeout", "label": "Gateway Timeout", "description": "The issuing bank did not respond in time.", "instrument": "CARD"},
    {"code": "payment_failed_because_insufficient_balance", "label": "Insufficient Balance", "description": "Customer does not have enough funds.", "instrument": "CARD"},
    {"code": "payment_failed_because_issuer_unavailable", "label": "Issuer Unavailable", "description": "The issuing bank's system is temporarily down.", "instrument": "CARD"},
    {"code": "payment_failed_because_incorrect_otp", "label": "Incorrect OTP", "description": "Customer entered the wrong OTP during 3DS verification.", "instrument": "CARD"},
    {"code": "U19", "label": "UPI Timeout", "description": "UPI transaction timed out at NPCI.", "instrument": "UPI"},
    {"code": "51", "label": "Insufficient Funds (ISO)", "description": "Card declined — insufficient funds in account.", "instrument": "CARD"},

    # HARD — permanent
    {"code": "payment_failed_because_card_expired", "label": "Card Expired", "description": "The card has expired. Customer must use a different card.", "instrument": "CARD"},
    {"code": "payment_failed_because_card_invalid", "label": "Invalid Card", "description": "The card number is invalid or does not exist.", "instrument": "CARD"},
    {"code": "payment_failed_because_account_closed", "label": "Account Closed", "description": "The customer's bank account has been closed.", "instrument": "CARD"},
    {"code": "payment_failed_because_card_lost_or_stolen", "label": "Lost/Stolen Card", "description": "The card has been reported lost or stolen.", "instrument": "CARD"},
    {"code": "payment_failed_because_invalid_vpa", "label": "Invalid VPA", "description": "The UPI VPA (Virtual Payment Address) is not valid.", "instrument": "UPI"},
    {"code": "54", "label": "Expired Card (ISO)", "description": "Card network reports the card is expired.", "instrument": "CARD"},

    # MANDATE — UPI/e-mandate lifecycle
    {"code": "U37", "label": "Mandate Revoked", "description": "Customer revoked their UPI autopay mandate.", "instrument": "UPI"},
    {"code": "U38", "label": "Mandate Paused", "description": "Customer paused their UPI mandate.", "instrument": "UPI"},
    {"code": "U39", "label": "Mandate Expired", "description": "The UPI mandate has expired.", "instrument": "UPI"},
    {"code": "U40", "label": "Mandate Not Found", "description": "No active mandate found at payer PSP.", "instrument": "UPI"},
    {"code": "U47", "label": "Pre-Debit Not Sent", "description": "Pre-debit notification was not sent before mandate execution.", "instrument": "UPI"},
    {"code": "R0", "label": "Stop Payment (Recurring)", "description": "Customer placed a stop payment order on recurring authorization.", "instrument": "CARD"},

    # UNKNOWN — ambiguous
    {"code": "payment_failed_because_do_not_honor", "label": "Do Not Honor", "description": "Bank declined without specific reason.", "instrument": "UPI"},
    {"code": "payment_failed_because_risk_check_failed", "label": "Risk Check Failed", "description": "Payment flagged by fraud/risk engine.", "instrument": "CARD"},
    {"code": "05", "label": "Do Not Honor (ISO)", "description": "Issuer declined — most common ambiguous code.", "instrument": "CARD"},
]

# Build lookup
_CODE_LOOKUP = {c["code"]: c for c in DECLINE_CODE_CATALOG}


class SimulatePaymentRequest(BaseModel):
    decline_code: str = Field(..., description="Decline code from the catalog")
    amount_paise: int = Field(default=150000, gt=0, le=10000000)
    customer_email: str = Field(default="ajogdand118@gmail.com")
    merchant_id: str = Field(default="merch_cloudnine_tech")


@router.get("/decline-codes")
async def list_decline_codes():
    """Return the catalog of available decline codes for simulation."""
    return {"codes": DECLINE_CODE_CATALOG}


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
    # Look up decline code from catalog
    catalog_entry = _CODE_LOOKUP.get(body.decline_code)
    if not catalog_entry:
        raise HTTPException(status_code=400, detail=f"Unknown decline code: {body.decline_code}")

    txn_id = f"pay_live_{uuid.uuid4().hex[:14]}"

    payload = WebhookPayload(
        gateway_event_id=f"evt_{uuid.uuid4().hex[:12]}",
        merchant_id=body.merchant_id,
        transaction_id=txn_id,
        subscription_id=f"sub_{hashlib.md5((body.customer_email + body.merchant_id).encode()).hexdigest()[:8]}",
        customer_id=f"cust_{hashlib.md5(body.customer_email.encode()).hexdigest()[:8]}",
        customer_email=body.customer_email,
        instrument_type=catalog_entry["instrument"],
        instrument_token=f"tok_{hashlib.md5(body.customer_email.encode()).hexdigest()[:12]}",
        error_code=catalog_entry["code"],
        error_description=catalog_entry["description"],
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
    if ingest_result.get("failure_class") == "MANDATE":
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
            "decline_code": body.decline_code,
            "decline_label": catalog_entry["label"],
            "amount_paise": body.amount_paise,
            "amount_display": f"\u20B9{body.amount_paise / 100:,.2f}",
            "customer_email": body.customer_email,
            "error_code": catalog_entry["code"],
            "error_description": catalog_entry["description"],
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
            "payment_id": f"pay_rcvr_{uuid.uuid4().hex[:12]}",
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

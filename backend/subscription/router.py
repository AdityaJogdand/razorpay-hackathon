"""
Failed-subscription recovery — Track 03 implementation.

Detects recurring payment failures by grouping on (subscription_id, instrument_token, merchant_id)
rather than customer_id alone, so unrelated subscriptions from the same customer are not
incorrectly merged.

Distinguishes structural failures (expired card, revoked mandate) from temporary ones
(gateway timeout, insufficient funds) and recommends bounded recovery interventions:

  Temporary (1st)   → AUTO_RETRY
  Temporary (2+)    → SEND_PAYMENT_LINK
  Expired card      → REQUEST_CARD_UPDATE   (REAUTH_REQUEST action via execution layer)
  Revoked mandate   → RE_AUTH_MANDATE       (REAUTH_REQUEST action via execution layer)
  3+ unresolved     → ESCALATE_TO_SUPPORT   (ESCALATE_HUMAN action via execution layer)

Card Update and Mandate Re-auth are first-class actions that route through the existing
agent → guardrail → execution pipeline.  Permanently failed instruments are never sent
through the normal retry path.
"""

from __future__ import annotations

import uuid
import logging
from collections import defaultdict
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.database import get_db
from backend.models.enums import ActionType, ActionStatus, LedgerEventType
from backend.models.tables import FailureEvent, Action
from backend.execution.service import execute_action
from backend.ledger.service import append as ledger_append

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/subscription", tags=["subscription"])

# ── Structural vs temporary classification ─────────────────────────────────

STRUCTURAL_CLASSES = {"HARD", "MANDATE"}


def _is_structural(failure_class: str) -> bool:
    return failure_class in STRUCTURAL_CLASSES


def _diagnose(failures: list[dict]) -> dict:
    """
    Diagnose a subscription failure group and recommend an intervention.

    Returns:
        {
          "diagnosis": "structural" | "temporary" | "chronic",
          "action": str,
          "label": str,
          "description": str,
          "urgency": "high" | "medium" | "low",
          "retryable": bool,
        }
    """
    latest = failures[0]
    fc = latest["failure_class"]
    count = len(failures)

    # ── Structural: card expired/invalid → Card Update (never retry)
    if fc == "HARD":
        return {
            "diagnosis": "structural",
            "action": "REQUEST_CARD_UPDATE",
            "label": "Request Card Update",
            "description": (
                "Card expired or invalid. Automated retries will fail. "
                "Customer must update payment method to restore subscription."
            ),
            "urgency": "high",
            "retryable": False,
        }

    # ── Structural: mandate revoked/expired → Re-auth (never retry)
    if fc == "MANDATE":
        return {
            "diagnosis": "structural",
            "action": "RE_AUTH_MANDATE",
            "label": "Re-authorize Mandate",
            "description": (
                "Mandate expired or revoked. Automated retries will fail. "
                "Customer mandate re-authorization required."
            ),
            "urgency": "high",
            "retryable": False,
        }

    # ── Chronic: 3+ temporary failures that haven't resolved → escalate
    if count >= 3:
        return {
            "diagnosis": "chronic",
            "action": "ESCALATE_TO_SUPPORT",
            "label": "Escalate to Support",
            "description": (
                f"{count} payment failures across this subscription. "
                "Automatic retries exhausted — support escalation required."
            ),
            "urgency": "high",
            "retryable": False,
        }

    # ── Repeated temporary: 2 soft failures → payment link outreach
    if count >= 2:
        return {
            "diagnosis": "temporary",
            "action": "SEND_PAYMENT_LINK",
            "label": "Send Payment Link",
            "description": (
                f"Recurring soft failure ({count}×). "
                "Send direct payment link to bypass failing billing path."
            ),
            "urgency": "medium",
            "retryable": True,
        }

    # ── First temporary failure → auto retry
    return {
        "diagnosis": "temporary",
        "action": "AUTO_RETRY",
        "label": "Auto Retry",
        "description": "First-time soft failure. Automatic retry scheduled.",
        "urgency": "low",
        "retryable": True,
    }


def _group_key(e) -> str:
    """
    Build the subscription grouping key.

    Priority: subscription_id (if present) > instrument_token + merchant_id.
    customer_id is appended as supporting context so that two different customers
    sharing the same instrument token (unlikely but possible) are not merged.
    """
    sub_id = e.subscription_id or ""
    if sub_id:
        return f"sub:{sub_id}|m:{e.merchant_id}|c:{e.customer_id}"
    return f"inst:{e.instrument_token}|m:{e.merchant_id}|c:{e.customer_id}"


def _event_to_dict(e) -> dict:
    fc = e.failure_class.value if hasattr(e.failure_class, "value") else str(e.failure_class)
    inst = e.instrument_type.value if hasattr(e.instrument_type, "value") else str(e.instrument_type)
    return {
        "id": str(e.id),
        "transaction_id": e.transaction_id,
        "subscription_id": e.subscription_id or None,
        "amount_paise": e.amount_paise,
        "currency": e.currency,
        "failure_class": fc,
        "decline_code": e.normalized_code,
        "decline_reason": e.raw_error_description or "",
        "instrument_type": inst,
        "instrument_token": e.instrument_token,
        "customer_email": e.customer_email or "",
        "customer_id": e.customer_id,
        "merchant_id": e.merchant_id,
        "failed_at": e.failed_at.isoformat() if e.failed_at else None,
    }


# In-memory tracking of triggered actions (maps group_key → action result)
_triggered_actions: dict[str, dict] = {}


# ── Endpoints ──────────────────────────────────────────────────────────────

@router.get("/recurring-failures")
async def get_recurring_failures(db: AsyncSession = Depends(get_db)):
    """
    Detect recurring payment failures grouped by subscription/instrument relationship.

    Returns only groups with 2+ failures (true recurring pattern).
    Single failures are excluded — they're handled by the normal agent pipeline.
    """
    result = await db.execute(
        select(FailureEvent).order_by(FailureEvent.failed_at.desc()).limit(500)
    )
    events = result.scalars().all()

    # Also load actions to check which events already have recovery actions
    action_result = await db.execute(
        select(Action).where(
            Action.action_type.in_([ActionType.REAUTH_REQUEST, ActionType.ESCALATE_HUMAN, ActionType.CONTACT_EMAIL])
        )
    )
    existing_actions = action_result.scalars().all()
    event_actions: dict[str, list[dict]] = defaultdict(list)
    for a in existing_actions:
        event_actions[str(a.failure_event_id)].append({
            "id": str(a.id),
            "action_type": a.action_type.value,
            "status": a.status.value,
            "executed_at": a.executed_at.isoformat() if a.executed_at else None,
            "outcome": a.outcome,
        })

    # Group by subscription/instrument relationship
    groups: dict[str, list[dict]] = defaultdict(list)
    for e in events:
        key = _group_key(e)
        groups[key].append(_event_to_dict(e))

    # Build subscription records — only 2+ failures (true recurring)
    subscriptions = []
    for key, failures in groups.items():
        if len(failures) < 2:
            continue

        latest = failures[0]
        diagnosis = _diagnose(failures)

        # Check if any event in this group already has a triggered action
        triggered = _triggered_actions.get(key)
        existing = []
        for f in failures:
            existing.extend(event_actions.get(f["id"], []))

        subscriptions.append({
            "group_key": key,
            "subscription_id": latest.get("subscription_id"),
            "customer_id": latest["customer_id"],
            "merchant_id": latest["merchant_id"],
            "customer_email": latest["customer_email"],
            "instrument_type": latest["instrument_type"],
            "instrument_token": latest["instrument_token"][:8] + "..." if latest["instrument_token"] else "",
            "failure_count": len(failures),
            "total_amount_paise": sum(f["amount_paise"] for f in failures),
            "latest_failure": latest,
            "failures": failures,
            "recommendation": diagnosis,
            "existing_actions": existing,
            "triggered_action": triggered,
        })

    subscriptions.sort(key=lambda s: (
        0 if s["recommendation"]["urgency"] == "high" else 1 if s["recommendation"]["urgency"] == "medium" else 2,
        -s["failure_count"],
    ))

    return {
        "subscriptions": subscriptions,
        "stats": {
            "total_groups": len(groups),
            "recurring_groups": len(subscriptions),
            "total_at_risk_paise": sum(s["total_amount_paise"] for s in subscriptions),
            "structural_count": sum(1 for s in subscriptions if any(_is_structural(f["failure_class"]) for f in s["failures"])),
            "chronic_count": sum(1 for s in subscriptions if s["failure_count"] >= 3),
            "temporary_count": sum(1 for s in subscriptions if s["recommendation"]["diagnosis"] == "temporary"),
            "high_urgency": sum(1 for s in subscriptions if s["recommendation"]["urgency"] == "high"),
            "medium_urgency": sum(1 for s in subscriptions if s["recommendation"]["urgency"] == "medium"),
            "actions_triggered": sum(1 for s in subscriptions if s["triggered_action"]),
        },
    }


class TriggerActionRequest(BaseModel):
    action: str  # REQUEST_CARD_UPDATE, RE_AUTH_MANDATE, SEND_PAYMENT_LINK, ESCALATE_TO_SUPPORT


@router.post("/trigger/{event_id}")
async def trigger_recovery_action(
    event_id: str,
    body: TriggerActionRequest,
    db: AsyncSession = Depends(get_db),
):
    """
    Trigger a recovery action for a subscription failure event.

    Routes through the existing execution layer (kill switch, ledger, etc.).
    Maps recommended actions to real ActionTypes:
      REQUEST_CARD_UPDATE  → REAUTH_REQUEST (email asking customer to update card)
      RE_AUTH_MANDATE      → REAUTH_REQUEST (email asking customer to re-auth mandate)
      SEND_PAYMENT_LINK    → CONTACT_EMAIL  (email with payment link)
      ESCALATE_TO_SUPPORT  → ESCALATE_HUMAN
    """
    event_uuid = uuid.UUID(event_id)
    result = await db.execute(
        select(FailureEvent).where(FailureEvent.id == event_uuid)
    )
    event = result.scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    # Map subscription action → ActionType
    action_map = {
        "REQUEST_CARD_UPDATE": ActionType.REAUTH_REQUEST,
        "RE_AUTH_MANDATE": ActionType.REAUTH_REQUEST,
        "SEND_PAYMENT_LINK": ActionType.CONTACT_EMAIL,
        "ESCALATE_TO_SUPPORT": ActionType.ESCALATE_HUMAN,
    }
    action_type = action_map.get(body.action)
    if not action_type:
        raise HTTPException(status_code=400, detail=f"Unknown action: {body.action}")

    # Prevent retrying structural failures
    fc = event.failure_class.value if hasattr(event.failure_class, "value") else str(event.failure_class)
    if body.action == "AUTO_RETRY" and _is_structural(fc):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot retry a structurally failed payment ({fc}). Use card update or re-auth instead."
        )

    now = datetime.now(timezone.utc)

    # Build email draft based on action type
    amount_display = f"\u20B9{event.amount_paise / 100:,.0f}"
    email_draft = None
    if body.action == "REQUEST_CARD_UPDATE":
        email_draft = {
            "subject": "Update your payment method to continue your subscription",
            "body": (
                f"Hi,\n\n"
                f"We're reaching out from the Razorpay team regarding your subscription payment "
                f"of {amount_display}.\n\n"
                f"Your saved card could not be used for this payment. This typically happens "
                f"when a card expires or is replaced by your bank.\n\n"
                f"To continue your subscription without interruption, please update your payment "
                f"method using the link below:\n\n"
                f"[Update Payment Method]\n\n"
                f"If you've already updated your card, you can disregard this message.\n\n"
                f"Regards,\nRazorpay Team"
            ),
        }
    elif body.action == "RE_AUTH_MANDATE":
        email_draft = {
            "subject": "Re-authorize your payment mandate to continue auto-pay",
            "body": (
                f"Hi,\n\n"
                f"We're reaching out from the Razorpay team regarding your auto-payment "
                f"of {amount_display}.\n\n"
                f"Your payment mandate is no longer active, so we were unable to process "
                f"this payment. This usually happens when a mandate expires or has been "
                f"cancelled.\n\n"
                f"To restore automatic payments, please set up a new mandate using the "
                f"link below. It takes less than 2 minutes:\n\n"
                f"[Re-authorize Mandate]\n\n"
                f"Regards,\nRazorpay Team"
            ),
        }
    elif body.action == "SEND_PAYMENT_LINK":
        email_draft = {
            "subject": f"Complete your payment of {amount_display}",
            "body": (
                f"Hi,\n\n"
                f"We're reaching out from the Razorpay team. Your recent payment of "
                f"{amount_display} could not be completed due to a temporary issue.\n\n"
                f"You can complete the payment securely using the link below:\n\n"
                f"[Complete Payment]\n\n"
                f"If you need any help, our support team is available 24/7.\n\n"
                f"Regards,\nRazorpay Team"
            ),
        }

    # Create the action row
    action_row = Action(
        id=uuid.uuid4(),
        failure_event_id=event.id,
        recovery_plan_id=None,
        merchant_id=event.merchant_id,
        action_type=action_type,
        status=ActionStatus.SCHEDULED,
        idempotency_key=f"{event.id}:SUB_RECOVERY:{body.action}:{uuid.uuid4().hex[:8]}",
        scheduled_at=now,
        retry_number=None,
        outcome={"subscription_recovery": True, "trigger": body.action},
    )
    db.add(action_row)
    await db.flush()

    # Execute through the existing execution layer (respects kill switch + audit ledger)
    exec_result = await execute_action(
        db=db,
        action=action_row,
        email_draft=email_draft,
        customer_email=event.customer_email,
        transaction_id=event.transaction_id,
        amount_paise=event.amount_paise,
        instrument_token=event.instrument_token,
        merchant_id=event.merchant_id,
    )

    await db.commit()

    # Track in memory for display
    group_key = _group_key(event)
    _triggered_actions[group_key] = {
        "action": body.action,
        "action_type": action_type.value,
        "action_id": exec_result.action_id,
        "status": exec_result.status,
        "detail": exec_result.detail,
        "triggered_at": now.isoformat(),
    }

    return {
        "event_id": str(event.id),
        "action": body.action,
        "action_type": action_type.value,
        "action_id": exec_result.action_id,
        "status": exec_result.status,
        "detail": exec_result.detail,
        "executed_at": exec_result.executed_at.isoformat() if exec_result.executed_at else None,
    }

"""
Checkout Drop-off Recovery — track and recover abandoned checkouts.

Simulates Razorpay Magic Checkout abandoned cart webhook:
  POST /checkout/abandon        — ingest an abandoned checkout event
  POST /checkout/simulate       — simulate an abandoned checkout (demo)
  GET  /checkout/events         — list all abandoned checkouts
  GET  /checkout/stats          — funnel stats
  POST /checkout/recover/{id}   — send recovery email for an abandoned checkout
  POST /checkout/complete/{id}  — simulate customer completing checkout
"""

import uuid
import logging
from datetime import datetime, timezone, timedelta
from enum import Enum

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select, func, case, literal
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.database import get_db
from backend.dashboard.ws import notify_dashboard_update
from backend.guardrail.engine import scrub_email_content
from backend.execution.service import send_email

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/checkout", tags=["checkout"])


# ── In-memory store (no DB migration needed for hackathon) ──

_checkout_events: list[dict] = []


class DropOffStage(str, Enum):
    """Where in the checkout funnel the customer dropped off."""
    LANDING = "LANDING"            # Opened checkout page, left immediately
    CONTACT_ENTERED = "CONTACT"    # Entered email/phone, didn't proceed
    ADDRESS_ENTERED = "ADDRESS"    # Entered address, didn't pick payment
    PAYMENT_SELECTED = "PAYMENT"   # Selected payment method, didn't complete
    PAYMENT_INITIATED = "INITIATED"  # Started payment (UPI intent/OTP), abandoned
    PAYMENT_FAILED = "FAILED"      # Payment attempt failed, didn't retry


class RecoveryStage(str, Enum):
    """Recovery email sequence stage."""
    NONE = "NONE"
    REMINDER_1H = "1H_SENT"
    REMINDER_24H = "24H_SENT"
    FINAL_72H = "72H_SENT"
    RECOVERED = "RECOVERED"
    EXPIRED = "EXPIRED"


STAGE_LABELS = {
    "LANDING": "Opened checkout",
    "CONTACT": "Entered contact info",
    "ADDRESS": "Entered address",
    "PAYMENT": "Selected payment method",
    "INITIATED": "Started payment",
    "FAILED": "Payment attempt failed",
}

# Drop-off reasons by stage
DROP_OFF_REASONS = {
    "LANDING": [
        "Price shock — shipping/tax added",
        "Just browsing — no purchase intent",
        "Page load too slow",
    ],
    "CONTACT": [
        "Didn't want to share contact info",
        "Distracted — will return later",
        "Comparing prices on other sites",
    ],
    "ADDRESS": [
        "Delivery not available to their area",
        "Shipping cost too high",
        "Complex address form",
    ],
    "PAYMENT": [
        "Preferred payment method not available",
        "Didn't trust the payment page",
        "Total amount higher than expected",
    ],
    "INITIATED": [
        "UPI app didn't open / intent failed",
        "OTP not received in time",
        "Changed mind during authentication",
    ],
    "FAILED": [
        "Insufficient funds",
        "Bank server timeout",
        "Card declined — didn't retry",
    ],
}


class SimulateCheckoutRequest(BaseModel):
    drop_off_stage: str = Field(..., pattern="^(LANDING|CONTACT|ADDRESS|PAYMENT|INITIATED|FAILED)$")
    amount_paise: int = Field(default=249900, gt=0, le=10000000)
    customer_email: str = Field(default="ajogdand112@gmail.com")
    customer_phone: str = Field(default="+91-98765-43210")
    product_name: str = Field(default="StreamBox Premium — Annual Plan")
    merchant_id: str = Field(default="merch_cloudnine_tech")


@router.post("/simulate")
async def simulate_checkout_abandon(body: SimulateCheckoutRequest):
    """Simulate an abandoned checkout event for demo."""
    import random

    reasons = DROP_OFF_REASONS.get(body.drop_off_stage, ["Unknown reason"])
    reason = random.choice(reasons)

    event = {
        "id": str(uuid.uuid4()),
        "merchant_id": body.merchant_id,
        "checkout_id": f"chk_{uuid.uuid4().hex[:16]}",
        "customer_email": body.customer_email if body.drop_off_stage != "LANDING" else None,
        "customer_phone": body.customer_phone if body.drop_off_stage not in ("LANDING",) else None,
        "product_name": body.product_name,
        "amount_paise": body.amount_paise,
        "amount_display": f"\u20B9{body.amount_paise / 100:,.2f}",
        "currency": "INR",
        "drop_off_stage": body.drop_off_stage,
        "drop_off_stage_label": STAGE_LABELS.get(body.drop_off_stage, body.drop_off_stage),
        "drop_off_reason": reason,
        "recovery_stage": RecoveryStage.NONE.value,
        "recovery_emails_sent": 0,
        "recovered": False,
        "abandoned_at": datetime.now(timezone.utc).isoformat(),
        "recovery_actions": [],
    }

    _checkout_events.append(event)
    await notify_dashboard_update("checkout_abandoned")

    return {
        "event": event,
        "recovery_eligible": body.drop_off_stage != "LANDING",
        "reason": "No contact info captured at landing stage" if body.drop_off_stage == "LANDING" else None,
    }


@router.get("/events")
async def list_checkout_events(
    limit: int = 50,
    stage: str | None = None,
):
    """List all abandoned checkout events."""
    events = list(reversed(_checkout_events))
    if stage:
        events = [e for e in events if e["drop_off_stage"] == stage]
    return {
        "events": events[:limit],
        "total": len(events),
    }


@router.get("/stats")
async def checkout_stats():
    """Funnel stats for abandoned checkouts."""
    total = len(_checkout_events)
    if total == 0:
        return {
            "total_abandoned": 0,
            "total_amount_paise": 0,
            "recovered_count": 0,
            "recovered_amount_paise": 0,
            "recovery_rate": 0,
            "by_stage": {},
            "by_recovery_stage": {},
            "funnel": [],
        }

    by_stage: dict[str, int] = {}
    by_recovery: dict[str, int] = {}
    recovered_count = 0
    recovered_amount = 0
    total_amount = 0

    for e in _checkout_events:
        stage = e["drop_off_stage"]
        by_stage[stage] = by_stage.get(stage, 0) + 1
        rs = e["recovery_stage"]
        by_recovery[rs] = by_recovery.get(rs, 0) + 1
        total_amount += e["amount_paise"]
        if e["recovered"]:
            recovered_count += 1
            recovered_amount += e["amount_paise"]

    # Build funnel (ordered stages)
    stage_order = ["LANDING", "CONTACT", "ADDRESS", "PAYMENT", "INITIATED", "FAILED"]
    funnel = [
        {
            "stage": s,
            "label": STAGE_LABELS.get(s, s),
            "count": by_stage.get(s, 0),
            "percent": round(by_stage.get(s, 0) / total * 100, 1) if total > 0 else 0,
        }
        for s in stage_order
    ]

    return {
        "total_abandoned": total,
        "total_amount_paise": total_amount,
        "total_amount_display": f"\u20B9{total_amount / 100:,.2f}",
        "recovered_count": recovered_count,
        "recovered_amount_paise": recovered_amount,
        "recovered_amount_display": f"\u20B9{recovered_amount / 100:,.2f}",
        "recovery_rate": round(recovered_count / total * 100, 1) if total > 0 else 0,
        "by_stage": by_stage,
        "by_recovery_stage": by_recovery,
        "funnel": funnel,
        "recoverable_count": len([e for e in _checkout_events if e["customer_email"] and not e["recovered"]]),
    }


def _build_recovery_email(event: dict) -> tuple[dict, str]:
    """Build the next recovery email draft and return (email_dict, next_stage)."""
    merchant_name = event["merchant_id"].replace("merch_", "").replace("merchant_", "").replace("_", " ").title()
    amount_display = event["amount_display"]
    product = event["product_name"]
    emails_sent = event["recovery_emails_sent"]

    if emails_sent == 0:
        email = scrub_email_content({
            "subject": f"You left something behind — {product}",
            "body": (
                f"Hi,\n\n"
                f"We noticed you started a purchase for {product} ({amount_display}) on "
                f"{merchant_name} but didn't complete checkout.\n\n"
                f"No worries — your cart is still saved. You can pick up right where "
                f"you left off:\n\n"
                f"[Complete Your Purchase]\n\n"
                f"If you ran into any issues during checkout, our support team is "
                f"happy to help.\n\n"
                f"Regards,\nRazorpay Team"
            ),
        })
        return email, RecoveryStage.REMINDER_1H.value

    elif emails_sent == 1:
        email = scrub_email_content({
            "subject": f"Still interested in {product}?",
            "body": (
                f"Hi,\n\n"
                f"We're reaching out from the Razorpay team. You started checking out "
                f"for {product} ({amount_display}) on {merchant_name} but didn't "
                f"complete the payment.\n\n"
                f"Here's what you can expect:\n"
                f"- Secure payment via UPI, cards, or net banking\n"
                f"- Instant confirmation once payment is complete\n"
                f"- Full refund if you change your mind within 7 days\n\n"
                f"[Complete Your Purchase]\n\n"
                f"If you had trouble with the payment process, we're here to help.\n\n"
                f"Regards,\nRazorpay Team"
            ),
        })
        return email, RecoveryStage.REMINDER_24H.value

    else:
        email = scrub_email_content({
            "subject": f"Last chance — your {product} cart expires soon",
            "body": (
                f"Hi,\n\n"
                f"Your saved cart for {product} ({amount_display}) on {merchant_name} "
                f"will expire soon.\n\n"
                f"If you'd still like to proceed, you can complete your purchase here:\n\n"
                f"[Complete Your Purchase]\n\n"
                f"If now isn't the right time, no problem — you can always come back "
                f"and start fresh when you're ready.\n\n"
                f"Regards,\nRazorpay Team"
            ),
        })
        return email, RecoveryStage.FINAL_72H.value


@router.get("/preview/{event_id}")
async def preview_recovery_email(event_id: str):
    """Preview the next recovery email without sending it."""
    event = next((e for e in _checkout_events if e["id"] == event_id), None)
    if not event:
        raise HTTPException(status_code=404, detail="Checkout event not found")
    if event["recovered"]:
        raise HTTPException(status_code=409, detail="Already recovered")
    if not event["customer_email"]:
        raise HTTPException(status_code=400, detail="No contact info")
    if event["recovery_emails_sent"] >= 3:
        raise HTTPException(status_code=400, detail="All emails already sent")

    email, next_stage = _build_recovery_email(event)
    return {
        "email": email,
        "email_number": event["recovery_emails_sent"] + 1,
        "stage": next_stage,
        "sent_to": event["customer_email"],
    }


@router.post("/recover/{event_id}")
async def send_recovery_email(event_id: str):
    """Send next recovery email in the sequence (1h → 24h → 72h)."""
    event = next((e for e in _checkout_events if e["id"] == event_id), None)
    if not event:
        raise HTTPException(status_code=404, detail="Checkout event not found")

    if event["recovered"]:
        raise HTTPException(status_code=409, detail="Already recovered")

    if not event["customer_email"]:
        raise HTTPException(status_code=400, detail="No contact info — cannot send recovery email")

    emails_sent = event["recovery_emails_sent"]
    email, next_stage = _build_recovery_email(event)

    # Send via SMTP (falls back to mock if Gmail not configured)
    smtp_result = send_email(
        to=event["customer_email"],
        subject=email["subject"],
        body=email["body"],
        merchant_id=event["merchant_id"],
    )
    logger.info(f"Checkout recovery email sent: {smtp_result}")

    # Record the recovery action
    action = {
        "id": str(uuid.uuid4()),
        "type": f"RECOVERY_EMAIL_{emails_sent + 1}",
        "stage": next_stage,
        "email": email,
        "sent_to": event["customer_email"],
        "sent_at": datetime.now(timezone.utc).isoformat(),
        "status": "SENT" if smtp_result.get("status") != "failed" else "FAILED",
        "smtp_status": smtp_result.get("status"),
    }
    event["recovery_actions"].append(action)
    event["recovery_stage"] = next_stage
    event["recovery_emails_sent"] = emails_sent + 1

    await notify_dashboard_update("checkout_recovery_email")

    return {
        "event_id": event_id,
        "email_number": emails_sent + 1,
        "stage": next_stage,
        "email": email,
        "sent_to": event["customer_email"],
        "remaining_emails": max(0, 3 - (emails_sent + 1)),
    }


@router.post("/complete/{event_id}")
async def simulate_checkout_complete(event_id: str):
    """Simulate customer completing checkout after recovery email."""
    event = next((e for e in _checkout_events if e["id"] == event_id), None)
    if not event:
        raise HTTPException(status_code=404, detail="Checkout event not found")

    if event["recovered"]:
        raise HTTPException(status_code=409, detail="Already recovered")

    event["recovered"] = True
    event["recovery_stage"] = RecoveryStage.RECOVERED.value
    event["recovered_at"] = datetime.now(timezone.utc).isoformat()
    event["recovery_actions"].append({
        "id": str(uuid.uuid4()),
        "type": "CHECKOUT_COMPLETED",
        "stage": RecoveryStage.RECOVERED.value,
        "sent_at": datetime.now(timezone.utc).isoformat(),
        "status": "COMPLETED",
        "payment_id": f"pay_recovered_{uuid.uuid4().hex[:12]}",
    })

    await notify_dashboard_update("checkout_recovered")

    return {
        "event_id": event_id,
        "status": "recovered",
        "amount_paise": event["amount_paise"],
        "amount_display": event["amount_display"],
        "product": event["product_name"],
        "detail": "Customer returned and completed checkout after recovery outreach",
    }

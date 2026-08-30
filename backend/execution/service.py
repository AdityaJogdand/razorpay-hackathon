"""
Execution layer — delivers recovery actions.

Three action types:
1. RETRY — call mock payment gateway to retry the charge
2. CONTACT_EMAIL / REAUTH_REQUEST — send email via Gmail SMTP
3. ESCALATE_HUMAN — mark for human review (no external call)

All actions are idempotent, logged to the audit ledger, and respect the kill switch.
"""

import logging
import smtplib
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from email.mime.text import MIMEText

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.config import settings
from backend.models.enums import ActionType, ActionStatus, LedgerEventType
from backend.models.tables import Action, ConfigVersion
from backend.ledger.service import append as ledger_append

logger = logging.getLogger(__name__)


@dataclass
class ExecutionResult:
    """Result of executing a single action."""
    action_id: str
    action_type: str
    status: str  # SUCCEEDED, FAILED, SUPPRESSED
    detail: str
    executed_at: datetime | None = None


# ──────────────────────────────────────────────
# Mock Gateway — simulates payment retry
# ──────────────────────────────────────────────

async def mock_gateway_retry(
    transaction_id: str,
    amount_paise: int,
    instrument_token: str,
    idempotency_key: str,
) -> dict:
    """
    Simulated payment gateway retry.

    In production this would call Razorpay's /payments API.
    For demo: uses a deterministic success rule based on the transaction ID.
    """
    # Deterministic mock: succeed if hash of txn_id is even
    import hashlib
    h = int(hashlib.sha256(f"{transaction_id}:{idempotency_key}".encode()).hexdigest(), 16)
    success = (h % 3) != 0  # ~67% success rate

    if success:
        return {
            "status": "captured",
            "payment_id": f"pay_mock_{uuid.uuid4().hex[:12]}",
            "amount": amount_paise,
        }
    else:
        return {
            "status": "failed",
            "error": {"code": "RETRY_DECLINED", "description": "Issuer still declining"},
        }


# ──────────────────────────────────────────────
# Email — send via Gmail SMTP
# ──────────────────────────────────────────────

def send_email(
    to: str,
    subject: str,
    body: str,
    merchant_id: str,
) -> dict:
    """
    Send email via Gmail SMTP.

    Uses plus-addressed variants for demo (e.g. user+recovery@gmail.com).
    Falls back to mock if Gmail credentials aren't configured.
    """
    if not settings.gmail_user or not settings.gmail_app_password:
        logger.info("Gmail not configured — using mock email sender")
        return {
            "status": "sent_mock",
            "message_id": f"mock_{uuid.uuid4().hex[:12]}",
            "to": to,
            "subject": subject,
        }

    try:
        msg = MIMEText(body, "plain")
        msg["Subject"] = subject
        msg["From"] = f"{merchant_id} Billing <{settings.gmail_user}>"
        msg["To"] = to

        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
            server.login(settings.gmail_user, settings.gmail_app_password)
            server.send_message(msg)

        return {
            "status": "sent",
            "to": to,
            "subject": subject,
        }
    except Exception as e:
        logger.error(f"Email send failed: {e}")
        return {
            "status": "failed",
            "error": str(e),
            "to": to,
        }


# ──────────────────────────────────────────────
# Execute a single action
# ──────────────────────────────────────────────

async def execute_action(
    db: AsyncSession,
    action: Action,
    email_draft: dict | None = None,
    customer_email: str | None = None,
    transaction_id: str = "",
    amount_paise: int = 0,
    instrument_token: str = "",
    merchant_id: str = "",
) -> ExecutionResult:
    """
    Execute a single recovery action.

    Checks kill switch, executes the action, updates status, logs to ledger.
    """
    now = datetime.now(timezone.utc)

    # Check kill switch
    config_result = await db.execute(
        select(ConfigVersion)
        .where(ConfigVersion.merchant_id == merchant_id, ConfigVersion.is_active == True)
        .order_by(ConfigVersion.version.desc())
        .limit(1)
    )
    config = config_result.scalar_one_or_none()
    if config and config.kill_switch:
        action.status = ActionStatus.SUPPRESSED
        action.executed_at = now
        action.outcome = {"reason": "kill_switch_active"}
        await db.flush()

        await ledger_append(
            db, merchant_id, LedgerEventType.ACTION_EXECUTED,
            action.failure_event_id, "action",
            {"action_id": str(action.id), "status": "SUPPRESSED", "reason": "kill_switch"},
        )

        return ExecutionResult(
            action_id=str(action.id),
            action_type=action.action_type.value,
            status="SUPPRESSED",
            detail="Kill switch is active. Execution halted.",
            executed_at=now,
        )

    # Mark as executing
    action.status = ActionStatus.EXECUTING
    action.executed_at = now
    await db.flush()

    # Execute based on action type
    outcome: dict = {}
    status = ActionStatus.SUCCEEDED

    if action.action_type == ActionType.RETRY:
        result = await mock_gateway_retry(
            transaction_id=transaction_id,
            amount_paise=amount_paise,
            instrument_token=instrument_token,
            idempotency_key=action.idempotency_key,
        )
        outcome = result
        if result["status"] != "captured":
            status = ActionStatus.FAILED

    elif action.action_type in (ActionType.CONTACT_EMAIL, ActionType.REAUTH_REQUEST):
        if email_draft and customer_email:
            result = send_email(
                to=customer_email,
                subject=email_draft.get("subject", "Payment Update"),
                body=email_draft.get("body", "Please update your payment method."),
                merchant_id=merchant_id,
            )
            outcome = result
            if result["status"] in ("sent", "sent_mock"):
                status = ActionStatus.SUCCEEDED
            else:
                status = ActionStatus.FAILED
        else:
            outcome = {"error": "no_email_draft_or_address"}
            status = ActionStatus.FAILED

    elif action.action_type == ActionType.ESCALATE_HUMAN:
        outcome = {"escalated": True, "queue": "human_review"}
        status = ActionStatus.UNRESOLVED

    # Update action
    action.status = status
    action.outcome = outcome
    await db.flush()

    # Audit log
    await ledger_append(
        db, merchant_id, LedgerEventType.ACTION_EXECUTED,
        action.failure_event_id, "action",
        {
            "action_id": str(action.id),
            "action_type": action.action_type.value,
            "status": status.value,
            "outcome": outcome,
        },
    )

    return ExecutionResult(
        action_id=str(action.id),
        action_type=action.action_type.value,
        status=status.value,
        detail=str(outcome),
        executed_at=now,
    )

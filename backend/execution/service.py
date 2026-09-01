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

def _build_html_email(subject: str, body: str, merchant_id: str) -> str:
    """Build a branded HTML email using Razorpay styling."""
    # Convert plain text body to HTML paragraphs
    paragraphs = body.strip().split("\n\n")
    body_html = "".join(f"<p style='margin:0 0 16px;line-height:1.6;color:#3b4055;font-size:15px;'>{p.replace(chr(10), '<br>')}</p>" for p in paragraphs)

    return f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
        <!-- Header -->
        <tr><td style="background:#2563eb;padding:24px 32px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td><span style="font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">Razorpay</span></td>
              <td align="right"><span style="font-size:12px;color:rgba(255,255,255,0.8);">Payment Recovery</span></td>
            </tr>
          </table>
        </td></tr>
        <!-- Body -->
        <tr><td style="padding:32px;">
          <h1 style="margin:0 0 20px;font-size:18px;font-weight:600;color:#1b1f2b;">{subject}</h1>
          {body_html}
        </td></tr>
        <!-- CTA -->
        <tr><td style="padding:0 32px 32px;">
          <a href="https://razorpay.com/payment-link/demo" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-size:14px;font-weight:600;">
            Update Payment Method
          </a>
        </td></tr>
        <!-- Footer -->
        <tr><td style="padding:20px 32px;border-top:1px solid #e5e8ec;background:#f9fafb;">
          <p style="margin:0;font-size:11px;color:#9ca3af;line-height:1.5;">
            This is an automated message from {merchant_id} via Razorpay.<br>
            If you believe this was sent in error, please contact support.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>"""


def send_email(
    to: str,
    subject: str,
    body: str,
    merchant_id: str,
) -> dict:
    """
    Send branded HTML email via Gmail SMTP.

    Uses plus-addressed variants for demo (e.g. user+recovery@gmail.com).
    Falls back to mock if Gmail credentials aren't configured.
    """
    html_body = _build_html_email(subject, body, merchant_id)

    if not settings.gmail_user or not settings.gmail_app_password:
        logger.info("Gmail not configured — using mock email sender")
        return {
            "status": "sent_mock",
            "message_id": f"mock_{uuid.uuid4().hex[:12]}",
            "to": to,
            "subject": subject,
        }

    try:
        msg = MIMEText(html_body, "html")
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
    # Sequence metadata (step number, draft, regulatory context) belongs to the
    # action for its whole lifecycle. Preserve it when adding execution results.
    existing_outcome = dict(action.outcome or {})

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
        action.outcome = {**existing_outcome, "reason": "kill_switch_active"}
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
        if not customer_email:
            outcome = {"error": "no_customer_email_on_file"}
            status = ActionStatus.FAILED
        else:
            # Generate fallback email if no draft provided
            if not email_draft:
                amount_display = f"\u20B9{amount_paise / 100:,.0f}" if amount_paise else "your recent payment"
                email_draft = {
                    "subject": f"Payment update needed — {merchant_id}",
                    "body": (
                        f"Hi,\n\n"
                        f"Your payment of {amount_display} could not be processed.\n\n"
                        f"Please update your payment method to continue your service.\n\n"
                        f"Best regards,\n{merchant_id} Billing"
                    ),
                }
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

    elif action.action_type == ActionType.ESCALATE_HUMAN:
        outcome = {"escalated": True, "queue": "human_review"}
        status = ActionStatus.UNRESOLVED

    # Update action
    action.status = status
    action.outcome = {**existing_outcome, **outcome}
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

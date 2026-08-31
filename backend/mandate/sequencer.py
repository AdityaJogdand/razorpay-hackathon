"""
Mandate Retry Sequencer — NPCI-compliant multi-step recovery for mandate failures.

Each mandate decline sub-type has specific retry rules based on NPCI UPI
Technical Specification and RBI e-Mandate Framework (DPSS.CO.PD.No.629).

Key constraints:
- Revoked/expired mandates must NEVER be retried — require fresh authorization
- Pre-debit notification must be sent 24h before any mandate execution
- Amount/limit breaches may be retried with adjusted parameters
- Execution date mismatches should be rescheduled to the correct window
"""

from __future__ import annotations

import enum
from dataclasses import dataclass, field


class MandateSubType(str, enum.Enum):
    REVOKED = "REVOKED"                   # U37, RM, R1, R3
    PAUSED = "PAUSED"                     # U38
    EXPIRED = "EXPIRED"                   # U39
    NOT_FOUND = "NOT_FOUND"               # U40
    DEBIT_LIMIT_BREACHED = "DEBIT_LIMIT"  # U41, AM
    EXECUTION_DATE_MISMATCH = "DATE_MISMATCH"  # U42
    CREATION_REJECTED = "CREATION_REJECTED"    # U43
    MODIFICATION_REJECTED = "MOD_REJECTED"     # U44
    AMOUNT_EXCEEDED = "AMOUNT_EXCEEDED"        # U45
    PAYER_PSP_REJECTED = "PSP_REJECTED"        # U46
    PRE_DEBIT_NOT_SENT = "PRE_DEBIT"           # U47
    STOP_PAYMENT = "STOP_PAYMENT"              # R0
    DEBIT_NOT_ALLOWED = "DEBIT_NOT_ALLOWED"    # general


# Map raw decline codes to mandate sub-types
DECLINE_CODE_TO_SUBTYPE: dict[str, MandateSubType] = {
    # NPCI UPI codes
    "U37": MandateSubType.REVOKED,
    "U38": MandateSubType.PAUSED,
    "U39": MandateSubType.EXPIRED,
    "U40": MandateSubType.NOT_FOUND,
    "U41": MandateSubType.DEBIT_LIMIT_BREACHED,
    "U42": MandateSubType.EXECUTION_DATE_MISMATCH,
    "U43": MandateSubType.CREATION_REJECTED,
    "U44": MandateSubType.MODIFICATION_REJECTED,
    "U45": MandateSubType.AMOUNT_EXCEEDED,
    "U46": MandateSubType.PAYER_PSP_REJECTED,
    "U47": MandateSubType.PRE_DEBIT_NOT_SENT,
    # Card recurring codes
    "R0": MandateSubType.STOP_PAYMENT,
    "R1": MandateSubType.REVOKED,
    "R3": MandateSubType.REVOKED,
    "RM": MandateSubType.REVOKED,
    "AM": MandateSubType.DEBIT_LIMIT_BREACHED,
    # Razorpay reason strings
    "payment_failed_because_mandate_revoked": MandateSubType.REVOKED,
    "payment_failed_because_mandate_paused": MandateSubType.PAUSED,
    "payment_failed_because_mandate_expired": MandateSubType.EXPIRED,
    "payment_failed_because_mandate_not_found": MandateSubType.NOT_FOUND,
    "payment_failed_because_debit_not_allowed_on_mandate": MandateSubType.DEBIT_NOT_ALLOWED,
}


class SequenceStepType(str, enum.Enum):
    SEND_PRE_DEBIT_NOTIFICATION = "SEND_PRE_DEBIT_NOTIFICATION"
    WAIT = "WAIT"
    SEND_REAUTH_EMAIL = "SEND_REAUTH_EMAIL"
    RETRY_DEBIT = "RETRY_DEBIT"
    RETRY_WITH_LOWER_AMOUNT = "RETRY_WITH_LOWER_AMOUNT"
    ESCALATE_HUMAN = "ESCALATE_HUMAN"
    SEND_MANDATE_RENEWAL_LINK = "SEND_MANDATE_RENEWAL_LINK"
    SCHEDULE_CORRECT_DATE = "SCHEDULE_CORRECT_DATE"
    CLOSE_NO_RECOVERY = "CLOSE_NO_RECOVERY"


class SequenceStepStatus(str, enum.Enum):
    PENDING = "PENDING"
    IN_PROGRESS = "IN_PROGRESS"
    COMPLETED = "COMPLETED"
    SKIPPED = "SKIPPED"
    FAILED = "FAILED"


@dataclass
class SequenceStep:
    step_number: int
    step_type: SequenceStepType
    description: str
    delay_hours: float  # hours to wait before this step
    status: SequenceStepStatus = SequenceStepStatus.PENDING
    outcome: dict | None = None
    regulatory_basis: str = ""


@dataclass
class MandateSequence:
    sub_type: MandateSubType
    retryable: bool
    max_attempts: int
    description: str
    regulatory_note: str
    steps: list[SequenceStep] = field(default_factory=list)


def classify_mandate_subtype(raw_error_code: str, normalized_code: str) -> MandateSubType:
    """Determine the specific mandate sub-type from decline codes."""
    for code in [raw_error_code, normalized_code]:
        if code in DECLINE_CODE_TO_SUBTYPE:
            return DECLINE_CODE_TO_SUBTYPE[code]
    return MandateSubType.DEBIT_NOT_ALLOWED


def build_sequence(
    sub_type: MandateSubType,
    amount_paise: int,
    has_email: bool,
) -> MandateSequence:
    """
    Build a multi-step recovery sequence based on the mandate sub-type.

    Each sub-type has specific NPCI-compliant recovery rules.
    """
    builders = {
        MandateSubType.REVOKED: _seq_revoked,
        MandateSubType.PAUSED: _seq_paused,
        MandateSubType.EXPIRED: _seq_expired,
        MandateSubType.NOT_FOUND: _seq_not_found,
        MandateSubType.DEBIT_LIMIT_BREACHED: _seq_debit_limit,
        MandateSubType.EXECUTION_DATE_MISMATCH: _seq_date_mismatch,
        MandateSubType.CREATION_REJECTED: _seq_creation_rejected,
        MandateSubType.MODIFICATION_REJECTED: _seq_mod_rejected,
        MandateSubType.AMOUNT_EXCEEDED: _seq_amount_exceeded,
        MandateSubType.PAYER_PSP_REJECTED: _seq_psp_rejected,
        MandateSubType.PRE_DEBIT_NOT_SENT: _seq_pre_debit,
        MandateSubType.STOP_PAYMENT: _seq_stop_payment,
        MandateSubType.DEBIT_NOT_ALLOWED: _seq_debit_not_allowed,
    }
    builder = builders.get(sub_type, _seq_debit_not_allowed)
    return builder(amount_paise, has_email)


# ── Sequence builders per sub-type ──

def _seq_revoked(amount_paise: int, has_email: bool) -> MandateSequence:
    steps = [
        SequenceStep(
            step_number=1,
            step_type=SequenceStepType.SEND_REAUTH_EMAIL,
            description="Send re-authorization request to customer",
            delay_hours=0,
            regulatory_basis="RBI: Revoked mandates require fresh AFA-based re-authorization",
        ),
        SequenceStep(
            step_number=2,
            step_type=SequenceStepType.WAIT,
            description="Wait 48h for customer to re-authorize",
            delay_hours=48,
        ),
        SequenceStep(
            step_number=3,
            step_type=SequenceStepType.SEND_REAUTH_EMAIL,
            description="Send reminder if no re-authorization received",
            delay_hours=0,
        ),
        SequenceStep(
            step_number=4,
            step_type=SequenceStepType.WAIT,
            description="Wait 72h for final re-authorization window",
            delay_hours=72,
        ),
        SequenceStep(
            step_number=5,
            step_type=SequenceStepType.ESCALATE_HUMAN,
            description="Escalate to collections team if no re-auth",
            delay_hours=0,
        ),
    ]
    if not has_email:
        steps = [
            SequenceStep(1, SequenceStepType.ESCALATE_HUMAN,
                         "No email on file — escalate immediately", 0),
        ]
    return MandateSequence(
        sub_type=MandateSubType.REVOKED,
        retryable=False,
        max_attempts=0,
        description="Mandate revoked by customer — payment retries will always fail",
        regulatory_note="NPCI U37/RM: Customer explicitly revoked mandate. RBI requires fresh AFA-based authorization. Never auto-retry.",
        steps=steps,
    )


def _seq_paused(amount_paise: int, has_email: bool) -> MandateSequence:
    steps = [
        SequenceStep(
            step_number=1,
            step_type=SequenceStepType.SEND_REAUTH_EMAIL,
            description="Notify customer: mandate is paused, request unpause",
            delay_hours=0,
            regulatory_basis="NPCI U38: Mandate paused — customer can unpause via PSP app",
        ),
        SequenceStep(
            step_number=2,
            step_type=SequenceStepType.WAIT,
            description="Wait 24h for customer to unpause mandate",
            delay_hours=24,
        ),
        SequenceStep(
            step_number=3,
            step_type=SequenceStepType.SEND_PRE_DEBIT_NOTIFICATION,
            description="Send pre-debit notification (required 24h before retry)",
            delay_hours=0,
            regulatory_basis="RBI: Pre-debit notification mandatory 24h before execution",
        ),
        SequenceStep(
            step_number=4,
            step_type=SequenceStepType.WAIT,
            description="Wait 24h after pre-debit notification (RBI requirement)",
            delay_hours=24,
        ),
        SequenceStep(
            step_number=5,
            step_type=SequenceStepType.RETRY_DEBIT,
            description="Retry mandate debit after unpause + pre-debit wait",
            delay_hours=0,
        ),
        SequenceStep(
            step_number=6,
            step_type=SequenceStepType.ESCALATE_HUMAN,
            description="Escalate if retry fails after unpause",
            delay_hours=24,
        ),
    ]
    if not has_email:
        steps = [steps[0]]
        steps[0] = SequenceStep(1, SequenceStepType.ESCALATE_HUMAN,
                                "No email — escalate for manual contact", 0)
    return MandateSequence(
        sub_type=MandateSubType.PAUSED,
        retryable=True,
        max_attempts=2,
        description="Mandate paused by customer — may be unpaused",
        regulatory_note="NPCI U38: Mandate paused. Customer must unpause via PSP. Pre-debit notification required before retry.",
        steps=steps,
    )


def _seq_expired(amount_paise: int, has_email: bool) -> MandateSequence:
    steps = [
        SequenceStep(
            step_number=1,
            step_type=SequenceStepType.SEND_MANDATE_RENEWAL_LINK,
            description="Send mandate renewal link to customer",
            delay_hours=0,
            regulatory_basis="RBI: Expired mandates require new registration with AFA",
        ),
        SequenceStep(
            step_number=2,
            step_type=SequenceStepType.WAIT,
            description="Wait 72h for customer to create new mandate",
            delay_hours=72,
        ),
        SequenceStep(
            step_number=3,
            step_type=SequenceStepType.SEND_REAUTH_EMAIL,
            description="Send reminder with renewal link",
            delay_hours=0,
        ),
        SequenceStep(
            step_number=4,
            step_type=SequenceStepType.WAIT,
            description="Final wait window for mandate renewal",
            delay_hours=96,
        ),
        SequenceStep(
            step_number=5,
            step_type=SequenceStepType.ESCALATE_HUMAN,
            description="Escalate — mandate not renewed",
            delay_hours=0,
        ),
    ]
    if not has_email:
        steps = [SequenceStep(1, SequenceStepType.ESCALATE_HUMAN,
                              "No email — escalate for mandate renewal", 0)]
    return MandateSequence(
        sub_type=MandateSubType.EXPIRED,
        retryable=False,
        max_attempts=0,
        description="Mandate expired — requires new mandate registration",
        regulatory_note="NPCI U39: Mandate expired. New mandate must be registered with fresh AFA. Retries will always fail.",
        steps=steps,
    )


def _seq_not_found(amount_paise: int, has_email: bool) -> MandateSequence:
    steps = [
        SequenceStep(
            step_number=1,
            step_type=SequenceStepType.SEND_MANDATE_RENEWAL_LINK,
            description="Send mandate registration link to customer",
            delay_hours=0,
            regulatory_basis="NPCI U40: No mandate exists — must create one",
        ),
        SequenceStep(
            step_number=2,
            step_type=SequenceStepType.WAIT,
            description="Wait 72h for mandate creation",
            delay_hours=72,
        ),
        SequenceStep(
            step_number=3,
            step_type=SequenceStepType.ESCALATE_HUMAN,
            description="Escalate if mandate not created",
            delay_hours=0,
        ),
    ]
    if not has_email:
        steps = [SequenceStep(1, SequenceStepType.ESCALATE_HUMAN,
                              "No email — escalate for mandate creation", 0)]
    return MandateSequence(
        sub_type=MandateSubType.NOT_FOUND,
        retryable=False,
        max_attempts=0,
        description="Mandate not found — must be registered",
        regulatory_note="NPCI U40: No mandate record found at payer PSP. Fresh mandate registration required.",
        steps=steps,
    )


def _seq_debit_limit(amount_paise: int, has_email: bool) -> MandateSequence:
    # Calculate suggested lower amount (80% of original, rounded)
    lower_amount = int(amount_paise * 0.8 / 100) * 100
    steps = [
        SequenceStep(
            step_number=1,
            step_type=SequenceStepType.SEND_PRE_DEBIT_NOTIFICATION,
            description=f"Send pre-debit notification for reduced amount (₹{lower_amount/100:,.0f})",
            delay_hours=0,
            regulatory_basis="RBI: Pre-debit notification required. Amount must be within mandate limit.",
        ),
        SequenceStep(
            step_number=2,
            step_type=SequenceStepType.WAIT,
            description="Wait 24h after pre-debit notification",
            delay_hours=24,
        ),
        SequenceStep(
            step_number=3,
            step_type=SequenceStepType.RETRY_WITH_LOWER_AMOUNT,
            description=f"Retry debit with reduced amount ₹{lower_amount/100:,.0f}",
            delay_hours=0,
        ),
        SequenceStep(
            step_number=4,
            step_type=SequenceStepType.SEND_REAUTH_EMAIL,
            description="If partial fails, ask customer to increase mandate limit",
            delay_hours=24,
        ),
        SequenceStep(
            step_number=5,
            step_type=SequenceStepType.ESCALATE_HUMAN,
            description="Escalate if limit increase not received",
            delay_hours=72,
        ),
    ]
    return MandateSequence(
        sub_type=MandateSubType.DEBIT_LIMIT_BREACHED,
        retryable=True,
        max_attempts=2,
        description=f"Mandate debit limit breached — amount ₹{amount_paise/100:,.0f} exceeds mandate limit",
        regulatory_note="NPCI U41/AM: Debit amount exceeds mandate limit. May retry with lower amount or request limit increase.",
        steps=steps,
    )


def _seq_date_mismatch(amount_paise: int, has_email: bool) -> MandateSequence:
    steps = [
        SequenceStep(
            step_number=1,
            step_type=SequenceStepType.SCHEDULE_CORRECT_DATE,
            description="Reschedule debit to correct mandate execution date",
            delay_hours=0,
            regulatory_basis="NPCI U42: Debit attempted outside mandate execution window",
        ),
        SequenceStep(
            step_number=2,
            step_type=SequenceStepType.SEND_PRE_DEBIT_NOTIFICATION,
            description="Send pre-debit notification for rescheduled date",
            delay_hours=0,
        ),
        SequenceStep(
            step_number=3,
            step_type=SequenceStepType.WAIT,
            description="Wait 24h after pre-debit notification",
            delay_hours=24,
        ),
        SequenceStep(
            step_number=4,
            step_type=SequenceStepType.RETRY_DEBIT,
            description="Execute debit on correct mandate date",
            delay_hours=0,
        ),
    ]
    return MandateSequence(
        sub_type=MandateSubType.EXECUTION_DATE_MISMATCH,
        retryable=True,
        max_attempts=2,
        description="Execution date mismatch — debit attempted outside mandate window",
        regulatory_note="NPCI U42: Debit must align with mandate execution date. Reschedule and retry with pre-debit notification.",
        steps=steps,
    )


def _seq_creation_rejected(amount_paise: int, has_email: bool) -> MandateSequence:
    steps = [
        SequenceStep(
            step_number=1,
            step_type=SequenceStepType.SEND_REAUTH_EMAIL,
            description="Inform customer mandate creation failed, request retry",
            delay_hours=0,
            regulatory_basis="NPCI U43: Mandate creation rejected by payer bank",
        ),
        SequenceStep(
            step_number=2,
            step_type=SequenceStepType.WAIT,
            description="Wait 48h for customer to retry mandate creation",
            delay_hours=48,
        ),
        SequenceStep(
            step_number=3,
            step_type=SequenceStepType.ESCALATE_HUMAN,
            description="Escalate if mandate still not created",
            delay_hours=0,
        ),
    ]
    return MandateSequence(
        sub_type=MandateSubType.CREATION_REJECTED,
        retryable=False,
        max_attempts=0,
        description="Mandate creation rejected by payer bank",
        regulatory_note="NPCI U43: Payer bank rejected mandate creation. Customer must retry through PSP.",
        steps=steps,
    )


def _seq_mod_rejected(amount_paise: int, has_email: bool) -> MandateSequence:
    steps = [
        SequenceStep(
            step_number=1,
            step_type=SequenceStepType.SEND_REAUTH_EMAIL,
            description="Inform customer mandate modification failed",
            delay_hours=0,
        ),
        SequenceStep(
            step_number=2,
            step_type=SequenceStepType.WAIT,
            description="Wait 48h for customer action",
            delay_hours=48,
        ),
        SequenceStep(
            step_number=3,
            step_type=SequenceStepType.ESCALATE_HUMAN,
            description="Escalate to support team",
            delay_hours=0,
        ),
    ]
    return MandateSequence(
        sub_type=MandateSubType.MODIFICATION_REJECTED,
        retryable=False,
        max_attempts=0,
        description="Mandate modification rejected by payer bank",
        regulatory_note="NPCI U44: Mandate modification rejected. Customer must retry or create new mandate.",
        steps=steps,
    )


def _seq_amount_exceeded(amount_paise: int, has_email: bool) -> MandateSequence:
    lower_amount = int(amount_paise * 0.8 / 100) * 100
    steps = [
        SequenceStep(
            step_number=1,
            step_type=SequenceStepType.RETRY_WITH_LOWER_AMOUNT,
            description=f"Retry with amount within mandate cap (₹{lower_amount/100:,.0f})",
            delay_hours=0,
            regulatory_basis="NPCI U45: Amount exceeds mandate cap. RBI limit: ₹1L card, ₹2L UPI.",
        ),
        SequenceStep(
            step_number=2,
            step_type=SequenceStepType.SEND_REAUTH_EMAIL,
            description="Ask customer to update mandate amount limit",
            delay_hours=24,
        ),
        SequenceStep(
            step_number=3,
            step_type=SequenceStepType.ESCALATE_HUMAN,
            description="Escalate if limit not updated",
            delay_hours=72,
        ),
    ]
    return MandateSequence(
        sub_type=MandateSubType.AMOUNT_EXCEEDED,
        retryable=True,
        max_attempts=1,
        description=f"Mandate amount cap exceeded — ₹{amount_paise/100:,.0f} over limit",
        regulatory_note="NPCI U45: Amount exceeds mandate limit. RBI caps: ₹1,00,000 for cards, ₹2,00,000 for UPI.",
        steps=steps,
    )


def _seq_psp_rejected(amount_paise: int, has_email: bool) -> MandateSequence:
    steps = [
        SequenceStep(
            step_number=1,
            step_type=SequenceStepType.WAIT,
            description="Wait 24h — PSP rejection may be transient",
            delay_hours=24,
        ),
        SequenceStep(
            step_number=2,
            step_type=SequenceStepType.SEND_PRE_DEBIT_NOTIFICATION,
            description="Send pre-debit notification before retry",
            delay_hours=0,
        ),
        SequenceStep(
            step_number=3,
            step_type=SequenceStepType.WAIT,
            description="Wait 24h after pre-debit notification",
            delay_hours=24,
        ),
        SequenceStep(
            step_number=4,
            step_type=SequenceStepType.RETRY_DEBIT,
            description="Retry mandate debit",
            delay_hours=0,
        ),
        SequenceStep(
            step_number=5,
            step_type=SequenceStepType.ESCALATE_HUMAN,
            description="Escalate if PSP continues rejecting",
            delay_hours=24,
        ),
    ]
    return MandateSequence(
        sub_type=MandateSubType.PAYER_PSP_REJECTED,
        retryable=True,
        max_attempts=2,
        description="Mandate rejected by payer PSP — may be transient",
        regulatory_note="NPCI U46: Payer PSP rejected. May succeed on retry after cooldown.",
        steps=steps,
    )


def _seq_pre_debit(amount_paise: int, has_email: bool) -> MandateSequence:
    steps = [
        SequenceStep(
            step_number=1,
            step_type=SequenceStepType.SEND_PRE_DEBIT_NOTIFICATION,
            description="Send required pre-debit notification to customer",
            delay_hours=0,
            regulatory_basis="RBI DPSS.CO.PD.No.629: Pre-debit notification mandatory 24h before execution",
        ),
        SequenceStep(
            step_number=2,
            step_type=SequenceStepType.WAIT,
            description="Wait 24h (RBI mandatory pre-debit window)",
            delay_hours=24,
        ),
        SequenceStep(
            step_number=3,
            step_type=SequenceStepType.RETRY_DEBIT,
            description="Retry mandate debit after pre-debit notification period",
            delay_hours=0,
        ),
    ]
    return MandateSequence(
        sub_type=MandateSubType.PRE_DEBIT_NOT_SENT,
        retryable=True,
        max_attempts=2,
        description="Pre-debit notification not sent — must notify then retry",
        regulatory_note="NPCI U47 + RBI: Pre-debit notification was not sent before mandate execution. Send notification, wait 24h, then retry.",
        steps=steps,
    )


def _seq_stop_payment(amount_paise: int, has_email: bool) -> MandateSequence:
    steps = [
        SequenceStep(
            step_number=1,
            step_type=SequenceStepType.SEND_REAUTH_EMAIL,
            description="Customer placed stop payment — request new authorization",
            delay_hours=0,
            regulatory_basis="ISO 8583 R0: Customer-initiated stop payment on recurring",
        ),
        SequenceStep(
            step_number=2,
            step_type=SequenceStepType.WAIT,
            description="Wait 72h for re-authorization",
            delay_hours=72,
        ),
        SequenceStep(
            step_number=3,
            step_type=SequenceStepType.ESCALATE_HUMAN,
            description="Escalate to retention team",
            delay_hours=0,
        ),
    ]
    if not has_email:
        steps = [SequenceStep(1, SequenceStepType.ESCALATE_HUMAN,
                              "No email — escalate immediately", 0)]
    return MandateSequence(
        sub_type=MandateSubType.STOP_PAYMENT,
        retryable=False,
        max_attempts=0,
        description="Stop payment order — customer revoked recurring authorization",
        regulatory_note="ISO 8583 R0: Customer placed stop payment on recurring charge. Fresh authorization required.",
        steps=steps,
    )


def _seq_debit_not_allowed(amount_paise: int, has_email: bool) -> MandateSequence:
    steps = [
        SequenceStep(
            step_number=1,
            step_type=SequenceStepType.SEND_REAUTH_EMAIL,
            description="Notify customer — debit not permitted on mandate",
            delay_hours=0,
        ),
        SequenceStep(
            step_number=2,
            step_type=SequenceStepType.WAIT,
            description="Wait 48h for customer action",
            delay_hours=48,
        ),
        SequenceStep(
            step_number=3,
            step_type=SequenceStepType.ESCALATE_HUMAN,
            description="Escalate for manual review",
            delay_hours=0,
        ),
    ]
    if not has_email:
        steps = [SequenceStep(1, SequenceStepType.ESCALATE_HUMAN,
                              "No email — escalate for manual review", 0)]
    return MandateSequence(
        sub_type=MandateSubType.DEBIT_NOT_ALLOWED,
        retryable=False,
        max_attempts=0,
        description="Debit not allowed on this mandate",
        regulatory_note="Mandate exists but debit not permitted. May need mandate modification or new mandate.",
        steps=steps,
    )

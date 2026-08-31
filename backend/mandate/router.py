"""
Mandate Retry Sequencer API — NPCI-compliant multi-step recovery sequences.

Endpoints:
  GET  /mandate/sequences          — list all mandate sequences for a merchant
  GET  /mandate/sequence/{event_id} — get sequence for a specific failure event
  POST /mandate/sequence/{event_id} — create/trigger sequence for a mandate failure
  POST /mandate/advance/{event_id}  — advance sequence to next step
  GET  /mandate/stats               — mandate recovery stats
"""

import uuid
import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.database import get_db
from backend.core.security import validate_uuid, mask_email
from backend.models.enums import (
    FailureClass, ActionType, ActionStatus, LedgerEventType,
)
from backend.models.tables import FailureEvent, Action, AuditLedger
from backend.ledger.service import append as ledger_append
from backend.execution.service import execute_action
from backend.dashboard.ws import notify_dashboard_update
from backend.mandate.sequencer import (
    MandateSubType,
    SequenceStepType,
    SequenceStepStatus,
    classify_mandate_subtype,
    build_sequence,
    DECLINE_CODE_TO_SUBTYPE,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/mandate", tags=["mandate"])


@router.get("/sequences")
async def list_mandate_sequences(
    merchant_id: str = "merchant_demo_001",
    limit: int = Query(50, le=200),
    db: AsyncSession = Depends(get_db),
):
    """List all MANDATE failure events with their recovery sequences."""
    result = await db.execute(
        select(FailureEvent)
        .where(
            FailureEvent.merchant_id == merchant_id,
            FailureEvent.failure_class == FailureClass.MANDATE,
        )
        .order_by(FailureEvent.failed_at.desc())
        .limit(limit)
    )
    events = list(result.scalars().all())

    event_ids = [e.id for e in events]
    if not event_ids:
        return {"sequences": [], "total": 0}

    # Load actions for these events
    actions_result = await db.execute(
        select(Action)
        .where(Action.failure_event_id.in_(event_ids))
        .order_by(Action.created_at.asc())
    )
    actions_by_event: dict[str, list] = {}
    for a in actions_result.scalars().all():
        actions_by_event.setdefault(str(a.failure_event_id), []).append(a)

    # Load ledger entries for mandate sequences
    ledger_result = await db.execute(
        select(AuditLedger)
        .where(
            AuditLedger.entity_id.in_(event_ids),
            AuditLedger.event_type == LedgerEventType.AGENT_PROPOSAL,
        )
        .order_by(AuditLedger.created_at.desc())
    )
    proposals_by_event: dict[str, dict] = {}
    for entry in ledger_result.scalars().all():
        key = str(entry.entity_id)
        if key not in proposals_by_event:
            proposals_by_event[key] = entry.data

    sequences = []
    for e in events:
        eid = str(e.id)
        sub_type = classify_mandate_subtype(e.raw_error_code, e.normalized_code)
        seq = build_sequence(sub_type, e.amount_paise, bool(e.customer_email))
        actions = actions_by_event.get(eid, [])
        proposal = proposals_by_event.get(eid, {})

        # Determine current step based on actions taken
        current_step = _determine_current_step(seq.steps, actions)

        sequences.append({
            "event_id": eid,
            "transaction_id": e.transaction_id,
            "customer_id": e.customer_id,
            "customer_email": mask_email(e.customer_email),
            "amount_paise": e.amount_paise,
            "decline_code": e.raw_error_code,
            "decline_reason": e.raw_error_description or e.raw_error_code,
            "failed_at": e.failed_at.isoformat(),
            "sub_type": sub_type.value,
            "sub_type_label": _sub_type_label(sub_type),
            "retryable": seq.retryable,
            "max_attempts": seq.max_attempts,
            "description": seq.description,
            "regulatory_note": seq.regulatory_note,
            "current_step": current_step,
            "total_steps": len(seq.steps),
            "steps": [
                {
                    "step_number": s.step_number,
                    "step_type": s.step_type.value,
                    "description": s.description,
                    "delay_hours": s.delay_hours,
                    "status": _step_status(s.step_number, current_step, actions, seq.steps).value,
                    "regulatory_basis": s.regulatory_basis,
                }
                for s in seq.steps
            ],
            "actions": [
                {
                    "id": str(a.id),
                    "action_type": a.action_type.value,
                    "status": a.status.value,
                    "scheduled_at": a.scheduled_at.isoformat() if a.scheduled_at else None,
                    "executed_at": a.executed_at.isoformat() if a.executed_at else None,
                    "outcome": a.outcome,
                }
                for a in actions
            ],
            "agent_reasoning": proposal.get("reasoning", ""),
        })

    total = (await db.execute(
        select(func.count(FailureEvent.id))
        .where(
            FailureEvent.merchant_id == merchant_id,
            FailureEvent.failure_class == FailureClass.MANDATE,
        )
    )).scalar() or 0

    return {"sequences": sequences, "total": total}


@router.get("/sequence/{event_id}")
async def get_mandate_sequence(
    event_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Get the recovery sequence for a specific mandate failure."""
    validate_uuid(event_id)
    result = await db.execute(
        select(FailureEvent).where(FailureEvent.id == uuid.UUID(event_id))
    )
    event = result.scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    if event.failure_class != FailureClass.MANDATE:
        raise HTTPException(status_code=400, detail="Event is not a MANDATE failure")

    sub_type = classify_mandate_subtype(event.raw_error_code, event.normalized_code)
    seq = build_sequence(sub_type, event.amount_paise, bool(event.customer_email))

    actions_result = await db.execute(
        select(Action)
        .where(Action.failure_event_id == event.id)
        .order_by(Action.created_at.asc())
    )
    actions = list(actions_result.scalars().all())
    current_step = _determine_current_step(seq.steps, actions)

    return {
        "event_id": str(event.id),
        "transaction_id": event.transaction_id,
        "customer_id": event.customer_id,
        "customer_email": mask_email(event.customer_email),
        "amount_paise": event.amount_paise,
        "decline_code": event.raw_error_code,
        "failed_at": event.failed_at.isoformat(),
        "sub_type": sub_type.value,
        "sub_type_label": _sub_type_label(sub_type),
        "retryable": seq.retryable,
        "max_attempts": seq.max_attempts,
        "description": seq.description,
        "regulatory_note": seq.regulatory_note,
        "current_step": current_step,
        "total_steps": len(seq.steps),
        "steps": [
            {
                "step_number": s.step_number,
                "step_type": s.step_type.value,
                "description": s.description,
                "delay_hours": s.delay_hours,
                "status": _step_status(s.step_number, current_step, actions, seq.steps).value,
                "regulatory_basis": s.regulatory_basis,
            }
            for s in seq.steps
        ],
        "actions": [
            {
                "id": str(a.id),
                "action_type": a.action_type.value,
                "status": a.status.value,
                "scheduled_at": a.scheduled_at.isoformat() if a.scheduled_at else None,
                "executed_at": a.executed_at.isoformat() if a.executed_at else None,
                "outcome": a.outcome,
            }
            for a in actions
        ],
    }


@router.post("/sequence/{event_id}")
async def create_mandate_sequence(
    event_id: str,
    db: AsyncSession = Depends(get_db),
):
    """
    Create and start a mandate recovery sequence.

    Builds the NPCI-compliant sequence based on decline sub-type,
    creates the first action, and logs to audit ledger.
    """
    validate_uuid(event_id)
    event_uuid = uuid.UUID(event_id)
    result = await db.execute(
        select(FailureEvent).where(FailureEvent.id == event_uuid)
    )
    event = result.scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    if event.failure_class != FailureClass.MANDATE:
        raise HTTPException(status_code=400, detail="Event is not a MANDATE failure")

    sub_type = classify_mandate_subtype(event.raw_error_code, event.normalized_code)
    seq = build_sequence(sub_type, event.amount_paise, bool(event.customer_email))

    now = datetime.now(timezone.utc)

    # Log sequence creation to audit ledger
    await ledger_append(
        db, event.merchant_id, LedgerEventType.AGENT_PROPOSAL,
        event.id, "mandate_sequence",
        {
            "type": "mandate_sequence_created",
            "sub_type": sub_type.value,
            "retryable": seq.retryable,
            "total_steps": len(seq.steps),
            "description": seq.description,
            "regulatory_note": seq.regulatory_note,
            "steps": [
                {
                    "step_number": s.step_number,
                    "step_type": s.step_type.value,
                    "description": s.description,
                    "delay_hours": s.delay_hours,
                }
                for s in seq.steps
            ],
        },
    )

    # Execute first step
    first_step = seq.steps[0] if seq.steps else None
    action_result = None

    if first_step:
        action_type = _step_to_action_type(first_step.step_type)
        action_row = Action(
            id=uuid.uuid4(),
            failure_event_id=event.id,
            recovery_plan_id=None,
            merchant_id=event.merchant_id,
            action_type=action_type,
            status=ActionStatus.PENDING_APPROVAL if action_type in (
                ActionType.CONTACT_EMAIL, ActionType.REAUTH_REQUEST
            ) else ActionStatus.SCHEDULED,
            idempotency_key=f"{event.id}:MANDATE_SEQ:{sub_type.value}:S{first_step.step_number}:{uuid.uuid4().hex[:8]}",
            scheduled_at=now,
            outcome={
                "mandate_sequence": True,
                "sub_type": sub_type.value,
                "step_number": first_step.step_number,
                "step_type": first_step.step_type.value,
                "email_draft": _generate_mandate_email(
                    sub_type, event.amount_paise, event.merchant_id
                ) if action_type in (ActionType.CONTACT_EMAIL, ActionType.REAUTH_REQUEST) else None,
                "customer_email": event.customer_email,
            },
        )
        db.add(action_row)
        await db.flush()

        action_result = {
            "action_id": str(action_row.id),
            "action_type": action_type.value,
            "status": action_row.status.value,
            "step_number": first_step.step_number,
        }

        # If it's an escalation or retry, execute immediately
        if action_type == ActionType.ESCALATE_HUMAN:
            exec_result = await execute_action(
                db=db,
                action=action_row,
                merchant_id=event.merchant_id,
            )
            action_result["status"] = exec_result.status

    await db.commit()
    await notify_dashboard_update("mandate_sequence_created")

    return {
        "event_id": str(event.id),
        "sub_type": sub_type.value,
        "sub_type_label": _sub_type_label(sub_type),
        "retryable": seq.retryable,
        "total_steps": len(seq.steps),
        "description": seq.description,
        "regulatory_note": seq.regulatory_note,
        "first_action": action_result,
    }


@router.post("/advance/{event_id}")
async def advance_mandate_sequence(
    event_id: str,
    db: AsyncSession = Depends(get_db),
):
    """
    Advance the mandate sequence to the next step.

    Determines current progress and executes the next scheduled step.
    """
    validate_uuid(event_id)
    event_uuid = uuid.UUID(event_id)
    result = await db.execute(
        select(FailureEvent).where(FailureEvent.id == event_uuid)
    )
    event = result.scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    sub_type = classify_mandate_subtype(event.raw_error_code, event.normalized_code)
    seq = build_sequence(sub_type, event.amount_paise, bool(event.customer_email))

    actions_result = await db.execute(
        select(Action)
        .where(Action.failure_event_id == event.id)
        .order_by(Action.created_at.asc())
    )
    actions = list(actions_result.scalars().all())
    current_step = _determine_current_step(seq.steps, actions)

    if current_step > len(seq.steps):
        raise HTTPException(status_code=400, detail="Sequence already complete")

    next_step = seq.steps[current_step - 1] if current_step <= len(seq.steps) else None
    if not next_step:
        raise HTTPException(status_code=400, detail="No next step available")

    # Skip WAIT steps (they're informational)
    if next_step.step_type == SequenceStepType.WAIT:
        # Find the next non-wait step
        for s in seq.steps[current_step:]:
            if s.step_type != SequenceStepType.WAIT:
                next_step = s
                break
        else:
            raise HTTPException(status_code=400, detail="Only wait steps remaining")

    now = datetime.now(timezone.utc)
    action_type = _step_to_action_type(next_step.step_type)

    action_row = Action(
        id=uuid.uuid4(),
        failure_event_id=event.id,
        recovery_plan_id=None,
        merchant_id=event.merchant_id,
        action_type=action_type,
        status=ActionStatus.PENDING_APPROVAL if action_type in (
            ActionType.CONTACT_EMAIL, ActionType.REAUTH_REQUEST
        ) else ActionStatus.SCHEDULED,
        idempotency_key=f"{event.id}:MANDATE_SEQ:{sub_type.value}:S{next_step.step_number}:{uuid.uuid4().hex[:8]}",
        scheduled_at=now,
        outcome={
            "mandate_sequence": True,
            "sub_type": sub_type.value,
            "step_number": next_step.step_number,
            "step_type": next_step.step_type.value,
            "email_draft": _generate_mandate_email(
                sub_type, event.amount_paise, event.merchant_id
            ) if action_type in (ActionType.CONTACT_EMAIL, ActionType.REAUTH_REQUEST) else None,
            "customer_email": event.customer_email,
        },
    )
    db.add(action_row)
    await db.flush()

    # Auto-execute escalations and retries
    exec_status = action_row.status.value
    if action_type in (ActionType.ESCALATE_HUMAN, ActionType.RETRY):
        exec_result = await execute_action(
            db=db,
            action=action_row,
            transaction_id=event.transaction_id,
            amount_paise=event.amount_paise,
            instrument_token=event.instrument_token,
            merchant_id=event.merchant_id,
        )
        exec_status = exec_result.status

    await ledger_append(
        db, event.merchant_id, LedgerEventType.ACTION_SCHEDULED,
        event.id, "mandate_sequence_step",
        {
            "step_number": next_step.step_number,
            "step_type": next_step.step_type.value,
            "action_type": action_type.value,
            "status": exec_status,
        },
    )

    await db.commit()
    await notify_dashboard_update("mandate_sequence_advanced")

    return {
        "event_id": str(event.id),
        "step_number": next_step.step_number,
        "step_type": next_step.step_type.value,
        "action_type": action_type.value,
        "status": exec_status,
        "description": next_step.description,
        "remaining_steps": len(seq.steps) - next_step.step_number,
    }


@router.get("/stats")
async def mandate_stats(
    merchant_id: str = "merchant_demo_001",
    db: AsyncSession = Depends(get_db),
):
    """Mandate recovery stats — sub-type breakdown and sequence progress."""
    # Total mandate events
    total = (await db.execute(
        select(func.count(FailureEvent.id))
        .where(
            FailureEvent.merchant_id == merchant_id,
            FailureEvent.failure_class == FailureClass.MANDATE,
        )
    )).scalar() or 0

    # Get all mandate events with their codes
    events_result = await db.execute(
        select(FailureEvent.id, FailureEvent.raw_error_code, FailureEvent.normalized_code, FailureEvent.amount_paise)
        .where(
            FailureEvent.merchant_id == merchant_id,
            FailureEvent.failure_class == FailureClass.MANDATE,
        )
    )
    events = events_result.all()

    # Sub-type breakdown
    sub_type_counts: dict[str, int] = {}
    total_amount = 0
    for _, raw_code, norm_code, amount in events:
        st = classify_mandate_subtype(raw_code, norm_code)
        sub_type_counts[st.value] = sub_type_counts.get(st.value, 0) + 1
        total_amount += amount

    # Count actions on mandate events
    mandate_event_ids = [eid for eid, _, _, _ in events]
    actions_result = await db.execute(
        select(Action.status, func.count(Action.id))
        .where(Action.failure_event_id.in_(mandate_event_ids))
        .group_by(Action.status)
    ) if mandate_event_ids else None

    action_status_counts: dict[str, int] = {}
    if actions_result:
        for status, count in actions_result.all():
            action_status_counts[status.value] = count

    # Retryable vs non-retryable
    retryable_types = {
        MandateSubType.PAUSED.value, MandateSubType.DEBIT_LIMIT_BREACHED.value,
        MandateSubType.EXECUTION_DATE_MISMATCH.value, MandateSubType.AMOUNT_EXCEEDED.value,
        MandateSubType.PAYER_PSP_REJECTED.value, MandateSubType.PRE_DEBIT_NOT_SENT.value,
    }
    retryable_count = sum(c for st, c in sub_type_counts.items() if st in retryable_types)
    non_retryable_count = sum(c for st, c in sub_type_counts.items() if st not in retryable_types)

    return {
        "total_mandate_events": total,
        "total_amount_paise": total_amount,
        "retryable_count": retryable_count,
        "non_retryable_count": non_retryable_count,
        "by_sub_type": {
            st: {
                "count": count,
                "label": _sub_type_label(MandateSubType(st)),
                "retryable": st in retryable_types,
            }
            for st, count in sub_type_counts.items()
        },
        "action_status": action_status_counts,
    }


# ── Helpers ──

def _determine_current_step(steps: list, actions: list) -> int:
    """Determine which step the sequence is currently on based on actions taken."""
    if not actions:
        return 1

    # Count fully completed non-wait actions (not pending)
    completed = len([a for a in actions if a.status in (
        ActionStatus.SUCCEEDED, ActionStatus.FAILED, ActionStatus.UNRESOLVED, ActionStatus.DENIED
    )])
    # Pending approval = still on that step (in progress)
    pending = len([a for a in actions if a.status == ActionStatus.PENDING_APPROVAL])

    if pending > 0 and completed == 0:
        # First step still awaiting approval — stay on step 1
        return 1

    # Map completed actions back to step numbers
    # Each completed action corresponds to a non-WAIT step
    non_wait_done = 0
    for s in steps:
        if s.step_type != SequenceStepType.WAIT:
            non_wait_done += 1
            if non_wait_done > completed:
                # This is the current active step
                # But if there's a pending action, we're on this step
                if pending > 0:
                    return s.step_number
                # Otherwise check if there's a WAIT before this step
                # that should be the current step
                prev_idx = s.step_number - 2  # 0-indexed
                if prev_idx >= 0 and steps[prev_idx].step_type == SequenceStepType.WAIT:
                    return steps[prev_idx].step_number
                return s.step_number
    return len(steps) + 1  # All done


def _step_status(step_number: int, current_step: int, actions: list, steps: list = None) -> SequenceStepStatus:
    """Determine the display status of a step."""
    # For WAIT steps: only mark completed if the step AFTER the wait has an action
    if steps:
        step_idx = step_number - 1
        if step_idx < len(steps) and steps[step_idx].step_type == SequenceStepType.WAIT:
            # Check if any action exists for a step after this wait
            later_step_numbers = {s.step_number for s in steps[step_idx + 1:]
                                  if s.step_type != SequenceStepType.WAIT}
            action_step_numbers = set()
            for a in actions:
                if a.outcome and isinstance(a.outcome, dict):
                    sn = a.outcome.get("step_number")
                    if sn:
                        action_step_numbers.add(sn)
            if later_step_numbers & action_step_numbers:
                return SequenceStepStatus.COMPLETED
            elif step_number < current_step:
                return SequenceStepStatus.IN_PROGRESS  # waiting period active
            else:
                return SequenceStepStatus.PENDING

    if step_number < current_step:
        return SequenceStepStatus.COMPLETED
    elif step_number == current_step:
        return SequenceStepStatus.IN_PROGRESS
    else:
        return SequenceStepStatus.PENDING


def _step_to_action_type(step_type: SequenceStepType) -> ActionType:
    """Map sequence step type to action type."""
    mapping = {
        SequenceStepType.SEND_PRE_DEBIT_NOTIFICATION: ActionType.CONTACT_EMAIL,
        SequenceStepType.SEND_REAUTH_EMAIL: ActionType.REAUTH_REQUEST,
        SequenceStepType.SEND_MANDATE_RENEWAL_LINK: ActionType.REAUTH_REQUEST,
        SequenceStepType.RETRY_DEBIT: ActionType.RETRY,
        SequenceStepType.RETRY_WITH_LOWER_AMOUNT: ActionType.RETRY,
        SequenceStepType.ESCALATE_HUMAN: ActionType.ESCALATE_HUMAN,
        SequenceStepType.SCHEDULE_CORRECT_DATE: ActionType.ESCALATE_HUMAN,
        SequenceStepType.CLOSE_NO_RECOVERY: ActionType.ESCALATE_HUMAN,
    }
    return mapping.get(step_type, ActionType.ESCALATE_HUMAN)


def _sub_type_label(sub_type: MandateSubType) -> str:
    """Human-readable label for mandate sub-types."""
    labels = {
        MandateSubType.REVOKED: "Mandate Revoked",
        MandateSubType.PAUSED: "Mandate Paused",
        MandateSubType.EXPIRED: "Mandate Expired",
        MandateSubType.NOT_FOUND: "Mandate Not Found",
        MandateSubType.DEBIT_LIMIT_BREACHED: "Debit Limit Breached",
        MandateSubType.EXECUTION_DATE_MISMATCH: "Execution Date Mismatch",
        MandateSubType.CREATION_REJECTED: "Creation Rejected",
        MandateSubType.MODIFICATION_REJECTED: "Modification Rejected",
        MandateSubType.AMOUNT_EXCEEDED: "Amount Exceeded",
        MandateSubType.PAYER_PSP_REJECTED: "PSP Rejected",
        MandateSubType.PRE_DEBIT_NOT_SENT: "Pre-Debit Not Sent",
        MandateSubType.STOP_PAYMENT: "Stop Payment Order",
        MandateSubType.DEBIT_NOT_ALLOWED: "Debit Not Allowed",
    }
    return labels.get(sub_type, sub_type.value)


def _generate_mandate_email(
    sub_type: MandateSubType,
    amount_paise: int,
    merchant_id: str,
) -> dict:
    """Generate sub-type-specific email drafts for mandate recovery."""
    amount_rupees = amount_paise / 100
    # Display-friendly merchant name (strip internal prefixes/suffixes)
    merchant_name = merchant_id.replace("merchant_", "").replace("_", " ").title() if merchant_id else "your service provider"

    templates = {
        MandateSubType.REVOKED: {
            "subject": f"We could not process your payment of ₹{amount_rupees:,.0f}",
            "body": (
                f"Hi,\n\n"
                f"We tried to process your recurring payment of ₹{amount_rupees:,.0f} "
                f"for {merchant_name}, but it did not go through because your "
                f"payment mandate has been revoked.\n\n"
                f"To fix this, please set up a new mandate. It takes less than "
                f"2 minutes and requires a one-time verification:\n\n"
                f"[Set up new mandate]\n\n"
                f"Once your mandate is active, your payments will resume automatically.\n\n"
                f"If you did not revoke this mandate or need help, reply to this email.\n\n"
                f"Thanks,\n{merchant_name}"
            ),
        },
        MandateSubType.PAUSED: {
            "subject": f"Your payment of ₹{amount_rupees:,.0f} is on hold",
            "body": (
                f"Hi,\n\n"
                f"Your recurring payment of ₹{amount_rupees:,.0f} for {merchant_name} "
                f"could not be processed because your mandate is currently paused.\n\n"
                f"You can resume it in a few taps:\n"
                f"1. Open your UPI app (Google Pay, PhonePe, Paytm, etc.)\n"
                f"2. Go to Mandates or Autopay settings\n"
                f"3. Find and unpause the mandate for {merchant_name}\n\n"
                f"Once unpaused, we will notify you 24 hours before the next "
                f"charge attempt as per RBI guidelines.\n\n"
                f"If you already unpaused it, you can ignore this email.\n\n"
                f"Thanks,\n{merchant_name}"
            ),
        },
        MandateSubType.EXPIRED: {
            "subject": f"Your payment mandate has expired — action needed",
            "body": (
                f"Hi,\n\n"
                f"Your payment mandate for ₹{amount_rupees:,.0f} with {merchant_name} "
                f"has expired. We were unable to process your recurring payment.\n\n"
                f"To continue without interruption, please create a new mandate:\n\n"
                f"[Renew mandate]\n\n"
                f"This is a quick process that requires a one-time verification "
                f"as per RBI e-mandate guidelines.\n\n"
                f"Thanks,\n{merchant_name}"
            ),
        },
        MandateSubType.NOT_FOUND: {
            "subject": f"We could not find your payment mandate",
            "body": (
                f"Hi,\n\n"
                f"We tried to process your recurring payment of ₹{amount_rupees:,.0f} "
                f"for {merchant_name}, but no active mandate was found on your account.\n\n"
                f"This usually happens when a mandate was not registered or was "
                f"removed by your bank.\n\n"
                f"You can set up a new mandate in under 2 minutes:\n\n"
                f"[Set up mandate]\n\n"
                f"Once active, your payments will process automatically.\n\n"
                f"Thanks,\n{merchant_name}"
            ),
        },
        MandateSubType.DEBIT_LIMIT_BREACHED: {
            "subject": f"Your payment of ₹{amount_rupees:,.0f} exceeds your mandate limit",
            "body": (
                f"Hi,\n\n"
                f"We could not process your payment of ₹{amount_rupees:,.0f} for "
                f"{merchant_name} because it exceeds the limit set on your current mandate.\n\n"
                f"To fix this, please update your mandate limit through your "
                f"UPI or banking app:\n"
                f"1. Open your UPI app or net banking\n"
                f"2. Go to Mandates or Autopay settings\n"
                f"3. Update the limit for {merchant_name}\n\n"
                f"Once updated, we will retry your payment automatically.\n\n"
                f"Thanks,\n{merchant_name}"
            ),
        },
        MandateSubType.PRE_DEBIT_NOT_SENT: {
            "subject": f"Upcoming payment of ₹{amount_rupees:,.0f} in 24 hours",
            "body": (
                f"Hi,\n\n"
                f"This is to let you know that ₹{amount_rupees:,.0f} will be "
                f"debited from your account in 24 hours as per your active "
                f"mandate with {merchant_name}.\n\n"
                f"Please ensure sufficient balance in your account. If you wish "
                f"to stop this payment, you can revoke or pause your mandate "
                f"through your UPI or banking app before the debit.\n\n"
                f"This notification is sent as per RBI e-mandate guidelines.\n\n"
                f"Thanks,\n{merchant_name}"
            ),
        },
    }

    default = {
        "subject": f"Your payment of ₹{amount_rupees:,.0f} needs attention",
        "body": (
            f"Hi,\n\n"
            f"We could not process your recurring payment of ₹{amount_rupees:,.0f} "
            f"for {merchant_name} due to an issue with your mandate.\n\n"
            f"Please update or re-authorize your payment method to continue:\n\n"
            f"[Update payment method]\n\n"
            f"If you already fixed this, you can ignore this email.\n\n"
            f"Thanks,\n{merchant_name}"
        ),
    }

    from backend.guardrail.engine import scrub_email_content
    draft = templates.get(sub_type, default)
    return scrub_email_content(draft)

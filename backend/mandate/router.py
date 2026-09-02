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
    merchant_id: str = "merch_cloudnine_tech",
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
    email_drafts_by_event: dict[str, dict] = {}
    for entry in ledger_result.scalars().all():
        key = str(entry.entity_id)
        if key not in proposals_by_event:
            proposals_by_event[key] = entry.data
        # The sequence-creation proposal is newer than the original agent
        # proposal, but only the latter contains the generated email copy.
        if key not in email_drafts_by_event and isinstance(entry.data.get("email_draft"), dict):
            email_drafts_by_event[key] = entry.data["email_draft"]

    sequences = []
    for e in events:
        eid = str(e.id)
        sub_type = classify_mandate_subtype(e.raw_error_code, e.normalized_code)
        seq = build_sequence(sub_type, e.amount_paise, bool(e.customer_email))
        actions = actions_by_event.get(eid, [])
        proposal = proposals_by_event.get(eid, {})

        # Determine current step based on actions taken
        current_step = _determine_current_step(seq.steps, actions)
        recovered_action = _recovery_action(actions)

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
            "recovered": recovered_action is not None,
            "recovered_at": recovered_action.executed_at.isoformat() if recovered_action and recovered_action.executed_at else None,
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
            "agent_email_draft": email_drafts_by_event.get(eid),
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
    recovered_action = _recovery_action(actions)

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
        "recovered": recovered_action is not None,
        "recovered_at": recovered_action.executed_at.isoformat() if recovered_action and recovered_action.executed_at else None,
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
        # The agent pipeline may already have created the first email draft.
        # Adopt it into the sequence rather than asking the customer twice.
        existing_result = await db.execute(
            select(Action)
            .where(
                Action.failure_event_id == event.id,
                Action.action_type == action_type,
                Action.status.in_((ActionStatus.PENDING_APPROVAL, ActionStatus.SCHEDULED)),
            )
            .order_by(Action.created_at.desc())
            .limit(1)
        )
        action_row = existing_result.scalar_one_or_none()
        if action_row:
            outcome = dict(action_row.outcome or {})
            outcome.update({
                "mandate_sequence": True,
                "sub_type": sub_type.value,
                "step_number": first_step.step_number,
                "step_type": first_step.step_type.value,
                "customer_email": event.customer_email,
                "amount_paise": event.amount_paise,
            })
            action_row.outcome = outcome
            # A sequence always begins with reviewer approval for customer
            # communication.  Older agent-created email actions may still be
            # scheduled, so convert them before exposing the sequence.
            if action_type in (ActionType.CONTACT_EMAIL, ActionType.REAUTH_REQUEST):
                action_row.status = ActionStatus.PENDING_APPROVAL
        else:
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
                        sub_type, event.amount_paise, event.merchant_id,
                        first_step.step_number,
                    ) if action_type in (ActionType.CONTACT_EMAIL, ActionType.REAUTH_REQUEST) else None,
                    "customer_email": event.customer_email,
                    "amount_paise": event.amount_paise,
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

    if _has_recovered(actions):
        raise HTTPException(
            status_code=409,
            detail="Payment already recovered; no further mandate outreach is required",
        )
    current_step = _determine_current_step(seq.steps, actions)

    if current_step > len(seq.steps):
        raise HTTPException(status_code=400, detail="Sequence already complete")

    next_step = seq.steps[current_step - 1] if current_step <= len(seq.steps) else None
    if not next_step:
        raise HTTPException(status_code=400, detail="No next step available")

    # A wait is a real cadence boundary, not a visual-only marker.  Do not
    # create the follow-up until the preceding approved email has had its
    # configured response window.
    if next_step.step_type == SequenceStepType.WAIT:
        _require_wait_elapsed(next_step, seq.steps, actions, now=datetime.now(timezone.utc))
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
                sub_type, event.amount_paise, event.merchant_id,
                next_step.step_number,
            ) if action_type in (ActionType.CONTACT_EMAIL, ActionType.REAUTH_REQUEST) else None,
            "customer_email": event.customer_email,
            "amount_paise": event.amount_paise,
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
    merchant_id: str = "merch_cloudnine_tech",
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
    """Determine progress from explicit sequence step numbers, never action order."""
    if _has_recovered(actions):
        # A captured payment is terminal regardless of where the customer was
        # in the outreach cadence.  Remaining messages must not be sent.
        return len(steps) + 1

    actions_by_step: dict[int, object] = {}
    assigned_action_ids: set[object] = set()
    for action in actions:
        outcome = action.outcome if isinstance(action.outcome, dict) else {}
        step_number = outcome.get("step_number")
        if isinstance(step_number, int):
            actions_by_step[step_number] = action
            assigned_action_ids.add(action.id)

    # A legacy action can represent only the first outreach step.  Mapping
    # untagged actions onto later steps pulls unrelated policy actions forward
    # and bypasses the sequence's wait boundaries.
    first_actionable = next((step for step in steps if step.step_type != SequenceStepType.WAIT), None)
    if first_actionable and first_actionable.step_number not in actions_by_step:
        expected_type = _step_to_action_type(first_actionable.step_type)
        matched = next(
            (action for action in reversed(actions)
             if action.id not in assigned_action_ids and action.action_type == expected_type),
            None,
        )
        if matched:
            actions_by_step[first_actionable.step_number] = matched

    terminal_statuses = {
        ActionStatus.SUCCEEDED,
        ActionStatus.FAILED,
        ActionStatus.UNRESOLVED,
        ActionStatus.DENIED,
    }

    for index, step in enumerate(steps):
        if step.step_type == SequenceStepType.WAIT:
            continue

        action = actions_by_step.get(step.step_number)
        if action is None:
            # A wait immediately before this step is active until the action is created.
            if index > 0 and steps[index - 1].step_type == SequenceStepType.WAIT:
                return steps[index - 1].step_number
            return step.step_number

        if action.status not in terminal_statuses:
            return step.step_number

        # A successful retry resolves the mandate; escalation is conditional and skipped.
        if step.step_type in (SequenceStepType.RETRY_DEBIT, SequenceStepType.RETRY_WITH_LOWER_AMOUNT) and action.status == ActionStatus.SUCCEEDED:
            return len(steps) + 1

    return len(steps) + 1


def _has_recovered(actions: list) -> bool:
    """Return whether a successful debit has recovered this failure event."""
    return _recovery_action(actions) is not None


def _recovery_action(actions: list):
    """Return the successful payment action, if the mandate has recovered."""
    return next((
        action for action in reversed(actions)
        if action.action_type == ActionType.RETRY
        and action.status == ActionStatus.SUCCEEDED
    ), None)


def _require_wait_elapsed(wait_step, steps: list, actions: list, now: datetime) -> None:
    """Enforce the response window immediately before a follow-up step."""
    wait_index = wait_step.step_number - 1
    if wait_index <= 0:
        return

    prior_step = steps[wait_index - 1]
    prior_action = next(
        (
            action for action in reversed(actions)
            if isinstance(action.outcome, dict)
            and action.outcome.get("step_number") == prior_step.step_number
        ),
        None,
    )
    if prior_action is None:
        first_actionable = next((step for step in steps if step.step_type != SequenceStepType.WAIT), None)
        if first_actionable and prior_step.step_number == first_actionable.step_number:
            expected_type = _step_to_action_type(prior_step.step_type)
            prior_action = next(
                (action for action in reversed(actions) if action.action_type == expected_type),
                None,
            )
    if prior_action is None:
        raise HTTPException(status_code=409, detail="Complete the previous step before starting its wait period")
    if prior_action.status != ActionStatus.SUCCEEDED:
        raise HTTPException(status_code=409, detail="Approve and send the previous email before advancing")

    started_at = prior_action.executed_at or prior_action.scheduled_at
    available_at = started_at + timedelta(hours=wait_step.delay_hours)
    if now < available_at:
        remaining_minutes = max(1, int((available_at - now).total_seconds() // 60))
        raise HTTPException(
            status_code=409,
            detail=f"Waiting period is still active; follow-up is available in {remaining_minutes} minutes",
        )


def _step_status(step_number: int, current_step: int, actions: list, steps: list = None) -> SequenceStepStatus:
    """Determine the display status of a step."""
    if steps:
        step_idx = step_number - 1
        if _has_recovered(actions):
            action_step_numbers = {
                a.outcome.get("step_number")
                for a in actions
                if isinstance(a.outcome, dict) and isinstance(a.outcome.get("step_number"), int)
            }
            if step_number not in action_step_numbers:
                return SequenceStepStatus.SKIPPED
        # Escalation is conditional: a captured retry means there is nothing to escalate.
        if step_idx < len(steps) and steps[step_idx].step_type == SequenceStepType.ESCALATE_HUMAN:
            if any(a.action_type == ActionType.RETRY and a.status == ActionStatus.SUCCEEDED for a in actions):
                return SequenceStepStatus.SKIPPED

    # Every earlier step, including an elapsed wait, has completed.
    if step_number < current_step:
        return SequenceStepStatus.COMPLETED

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

    if step_number == current_step:
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
    step_number: int = 1,
) -> dict:
    """Generate an initial or conditional follow-up email draft."""
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
    draft = dict(templates.get(sub_type, default))
    if step_number > 1:
        draft["subject"] = f"Reminder: {draft['subject']}"
        draft["body"] = (
            f"Hi,\n\n"
            f"We are following up on our earlier message about your payment of "
            f"₹{amount_rupees:,.0f} for {merchant_name}. We have not received "
            f"confirmation that the payment has been recovered yet.\n\n"
            f"{draft['body'].removeprefix('Hi,\\n\\n')}"
        )
    return scrub_email_content(draft)

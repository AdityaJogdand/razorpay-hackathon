"""Dashboard API — aggregated views for the frontend."""

from enum import Enum

from fastapi import APIRouter, Depends, Query, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.database import get_db
from backend.core.security import mask_email, mask_token, validate_uuid
from backend.models.enums import (
    FailureClass, ActionType, ActionStatus, LedgerEventType,
)
from backend.models.tables import FailureEvent, Action, Suppression, AuditLedger, ExceptionResolution
from backend.dashboard.ws import notify_dashboard_update

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("/events")
async def list_failure_events(
    merchant_id: str = "merchant_demo_001",
    limit: int = Query(50, le=200),
    offset: int = 0,
    failure_class: str | None = None,
    db: AsyncSession = Depends(get_db),
):
    """
    List failure events with agent proposals, guardrail results, and actions.
    This is the main data source for the Decision Trace dashboard.
    """
    query = (
        select(FailureEvent)
        .where(FailureEvent.merchant_id == merchant_id)
    )
    if failure_class:
        query = query.where(FailureEvent.failure_class == FailureClass(failure_class))

    query = query.order_by(FailureEvent.ingested_at.desc()).offset(offset).limit(limit)

    result = await db.execute(query)
    events = list(result.scalars().all())

    # Get total count
    count_query = select(func.count(FailureEvent.id)).where(
        FailureEvent.merchant_id == merchant_id
    )
    if failure_class:
        count_query = count_query.where(FailureEvent.failure_class == FailureClass(failure_class))
    total = (await db.execute(count_query)).scalar() or 0

    # Batch-load actions and ledger entries for these events
    event_ids = [e.id for e in events]
    if not event_ids:
        return {"events": [], "total": 0}

    # Load actions
    actions_result = await db.execute(
        select(Action)
        .where(Action.failure_event_id.in_(event_ids))
        .order_by(Action.created_at.asc())
    )
    actions_by_event: dict[str, list] = {}
    for a in actions_result.scalars().all():
        key = str(a.failure_event_id)
        actions_by_event.setdefault(key, []).append(a)

    # Load agent proposals and guardrail results from ledger
    ledger_result = await db.execute(
        select(AuditLedger)
        .where(
            AuditLedger.entity_id.in_(event_ids),
            AuditLedger.event_type.in_([
                LedgerEventType.AGENT_PROPOSAL,
                LedgerEventType.GUARDRAIL_RESULT,
            ]),
        )
        .order_by(AuditLedger.created_at.desc())
    )
    proposals_by_event: dict[str, dict] = {}
    guardrails_by_event: dict[str, dict] = {}
    for entry in ledger_result.scalars().all():
        key = str(entry.entity_id)
        if entry.event_type == LedgerEventType.AGENT_PROPOSAL and key not in proposals_by_event:
            proposals_by_event[key] = entry.data
        elif entry.event_type == LedgerEventType.GUARDRAIL_RESULT and key not in guardrails_by_event:
            guardrails_by_event[key] = entry.data

    # Load suppressions
    supp_result = await db.execute(
        select(Suppression).where(Suppression.failure_event_id.in_(event_ids))
    )
    suppressions_by_event: dict[str, list] = {}
    for s in supp_result.scalars().all():
        key = str(s.failure_event_id)
        suppressions_by_event.setdefault(key, []).append({
            "rule_name": s.rule_name,
            "reason": s.reason,
            "action_type": s.action_type.value,
        })

    # Build response
    items = []
    for e in events:
        eid = str(e.id)
        proposal = proposals_by_event.get(eid, {})
        guardrail = guardrails_by_event.get(eid, {})
        actions = actions_by_event.get(eid, [])
        supps = suppressions_by_event.get(eid, [])

        # Determine outcome from actions
        outcome = "pending"
        outcome_detail = "Awaiting processing"
        recovered_amount = 0
        if actions:
            # Only a successful RETRY means money was recovered
            retry_succeeded = [a for a in actions if a.status == ActionStatus.SUCCEEDED and a.action_type == ActionType.RETRY]
            email_succeeded = [a for a in actions if a.status == ActionStatus.SUCCEEDED and a.action_type in (ActionType.CONTACT_EMAIL, ActionType.REAUTH_REQUEST)]
            email_pending = [a for a in actions if a.status == ActionStatus.PENDING_APPROVAL and a.action_type in (ActionType.CONTACT_EMAIL, ActionType.REAUTH_REQUEST)]
            email_denied = [a for a in actions if a.status == ActionStatus.DENIED and a.action_type in (ActionType.CONTACT_EMAIL, ActionType.REAUTH_REQUEST)]
            escalated = [a for a in actions if a.action_type == ActionType.ESCALATE_HUMAN]
            failed = [a for a in actions if a.status == ActionStatus.FAILED]
            scheduled = [a for a in actions if a.status == ActionStatus.SCHEDULED]

            if retry_succeeded:
                outcome = "recovered"
                outcome_detail = f"Payment recovered via retry"
                recovered_amount = e.amount_paise
            elif email_succeeded:
                outcome = "contacted"
                outcome_detail = f"Customer contacted via email"
            elif email_pending:
                outcome = "pending"
                outcome_detail = "Email awaiting human approval"
            elif email_denied:
                outcome = "suppressed"
                outcome_detail = "Email denied by human review"
            elif escalated:
                outcome = "escalated"
                outcome_detail = "Escalated to human review"
            elif all(a.status in (ActionStatus.FAILED, ActionStatus.SUPPRESSED, ActionStatus.DENIED) for a in actions):
                outcome = "failed"
                outcome_detail = "All actions failed"
            elif scheduled:
                outcome = "pending"
                outcome_detail = f"{len(scheduled)} action(s) scheduled"
            elif any(a.status == ActionStatus.SUPPRESSED for a in actions):
                outcome = "suppressed"
                outcome_detail = "Action suppressed by guardrail"

        # Only mark as suppressed if there are NO actions at all
        # (policy engine always creates some suppressions alongside valid actions)
        if supps and not actions and outcome == "pending":
            outcome = "suppressed"
            outcome_detail = supps[0]["reason"]

        # Determine guardrail status
        guardrail_status = "approved"
        if guardrail.get("overridden"):
            guardrail_status = "overridden"

        items.append({
            "id": eid,
            "transaction_id": e.transaction_id,
            "merchant_id": e.merchant_id,
            "customer_id": e.customer_id,
            "customer_email": mask_email(e.customer_email),
            "instrument_type": e.instrument_type.value,
            "instrument_token": mask_token(e.instrument_token),
            "amount_paise": e.amount_paise,
            "currency": e.currency,
            "decline_code": e.raw_error_code,
            "decline_reason": e.raw_error_description or e.raw_error_code,
            "failure_class": e.failure_class.value if e.failure_class else "UNKNOWN",
            "classification_confidence": e.classification_confidence or 0,
            "classification_source": e.classification_source or "RULES",
            "failed_at": e.failed_at.isoformat(),
            "agent": {
                "proposed_action": proposal.get("proposed_action", ""),
                "reasoning": proposal.get("reasoning", ""),
                "confidence": proposal.get("confidence", 0),
                "retry_schedule": proposal.get("retry_schedule"),
                "has_email_draft": proposal.get("has_email_draft", False),
                "email_draft": proposal.get("email_draft"),
            },
            "guardrail": {
                "status": guardrail_status,
                "checks": guardrail.get("checks", []),
                "override_reason": guardrail.get("override_reason"),
                "final_action": guardrail.get("final_action", ""),
                "shacl": guardrail.get("shacl"),
            },
            # Fallback action from policy engine actions (when agent hasn't processed yet)
            "policy_action": actions[0].action_type.value if actions else "",
            "outcome": outcome,
            "outcome_detail": outcome_detail,
            "recovered_amount": recovered_amount,
            "actions": [
                {
                    "id": str(a.id),
                    "action_type": a.action_type.value,
                    "status": a.status.value,
                    "scheduled_at": a.scheduled_at.isoformat() if a.scheduled_at else None,
                    "executed_at": a.executed_at.isoformat() if a.executed_at else None,
                    "retry_number": a.retry_number,
                    "outcome": a.outcome,
                }
                for a in actions
            ],
            "suppressions": supps,
        })

    return {"events": items, "total": total}


@router.get("/summary")
async def dashboard_summary(
    merchant_id: str = "merchant_demo_001",
    db: AsyncSession = Depends(get_db),
):
    """
    Aggregated summary stats for the dashboard header cards.
    """
    # Total events
    total = (await db.execute(
        select(func.count(FailureEvent.id))
        .where(FailureEvent.merchant_id == merchant_id)
    )).scalar() or 0

    # Counts by failure class
    class_counts = {}
    class_result = await db.execute(
        select(FailureEvent.failure_class, func.count(FailureEvent.id))
        .where(FailureEvent.merchant_id == merchant_id)
        .group_by(FailureEvent.failure_class)
    )
    for fc, count in class_result.all():
        class_counts[fc.value if fc else "UNKNOWN"] = count

    # Action stats
    action_result = await db.execute(
        select(Action.status, func.count(Action.id))
        .where(Action.merchant_id == merchant_id)
        .group_by(Action.status)
    )
    action_counts = {}
    for status, count in action_result.all():
        action_counts[status.value] = count

    # Recovered amount (only count successful RETRIES — email sends are not recovery)
    recovered_result = await db.execute(
        select(func.sum(FailureEvent.amount_paise))
        .join(Action, Action.failure_event_id == FailureEvent.id)
        .where(
            Action.merchant_id == merchant_id,
            Action.status == ActionStatus.SUCCEEDED,
            Action.action_type == ActionType.RETRY,
        )
    )
    recovered_amount = recovered_result.scalar() or 0

    # Guardrail overrides: count suppressed actions (agent proposal overridden by guardrail)
    suppression_count = (await db.execute(
        select(func.count(Action.id))
        .where(
            Action.merchant_id == merchant_id,
            Action.status == ActionStatus.SUPPRESSED,
        )
    )).scalar() or 0

    # Pending count: events with SCHEDULED actions but no SUCCEEDED action
    events_with_success = (
        select(Action.failure_event_id)
        .where(
            Action.merchant_id == merchant_id,
            Action.status == ActionStatus.SUCCEEDED,
        )
        .distinct()
    )
    events_with_scheduled = (
        select(Action.failure_event_id)
        .where(
            Action.merchant_id == merchant_id,
            Action.status == ActionStatus.SCHEDULED,
        )
        .distinct()
    )
    pending_count = (await db.execute(
        select(func.count(FailureEvent.id))
        .where(
            FailureEvent.merchant_id == merchant_id,
            FailureEvent.id.in_(events_with_scheduled),
            FailureEvent.id.notin_(events_with_success),
        )
    )).scalar() or 0

    # Exception count (UNKNOWN class minus resolved ones)
    total_unknown = class_counts.get("UNKNOWN", 0)
    resolved_exceptions = (await db.execute(
        select(func.count(ExceptionResolution.id))
        .where(ExceptionResolution.merchant_id == merchant_id)
    )).scalar() or 0
    exception_count = max(0, total_unknown - resolved_exceptions)

    return {
        "total_events": total,
        "recovered_amount_paise": recovered_amount,
        "recovered_count": (await db.execute(
            select(func.count(Action.id))
            .where(
                Action.merchant_id == merchant_id,
                Action.status == ActionStatus.SUCCEEDED,
                Action.action_type == ActionType.RETRY,
            )
        )).scalar() or 0,
        "pending_count": pending_count,
        "override_count": suppression_count,
        "exception_count": exception_count,
        "by_class": class_counts,
        "by_action_status": action_counts,
    }


# --- Exception Resolution Endpoints ---

class ResolutionType(str, Enum):
    APPROVE_SOFT = "APPROVE_SOFT"
    OVERRIDE_HARD = "OVERRIDE_HARD"
    OVERRIDE_SOFT = "OVERRIDE_SOFT"
    OVERRIDE_MANDATE = "OVERRIDE_MANDATE"
    ESCALATE = "ESCALATE"


class ResolveExceptionRequest(BaseModel):
    resolution_type: ResolutionType
    notes: str | None = Field(None, max_length=1000)


@router.post("/exceptions/{event_id}/resolve")
async def resolve_exception(
    event_id: str,
    body: ResolveExceptionRequest,
    merchant_id: str = "merchant_demo_001",
    db: AsyncSession = Depends(get_db),
):
    """Mark an exception queue item as resolved by a human reviewer."""
    validate_uuid(event_id)

    # Check if already resolved
    existing = await db.execute(
        select(ExceptionResolution).where(ExceptionResolution.failure_event_id == event_id)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Already resolved")

    resolution = ExceptionResolution(
        failure_event_id=event_id,
        merchant_id=merchant_id,
        resolution_type=body.resolution_type.value,
        notes=body.notes,
    )
    db.add(resolution)
    await db.commit()
    await db.refresh(resolution)
    await notify_dashboard_update("exception_resolved")

    return {
        "id": str(resolution.id),
        "failure_event_id": str(resolution.failure_event_id),
        "resolution_type": resolution.resolution_type,
        "resolved_at": resolution.resolved_at.isoformat(),
    }


@router.get("/exceptions/resolutions")
async def list_resolutions(
    merchant_id: str = "merchant_demo_001",
    db: AsyncSession = Depends(get_db),
):
    """Get all resolved exception IDs for the merchant."""
    result = await db.execute(
        select(ExceptionResolution)
        .where(ExceptionResolution.merchant_id == merchant_id)
        .order_by(ExceptionResolution.resolved_at.desc())
    )
    resolutions = result.scalars().all()
    return {
        "resolutions": [
            {
                "id": str(r.id),
                "failure_event_id": str(r.failure_event_id),
                "resolution_type": r.resolution_type,
                "resolved_by": r.resolved_by,
                "notes": r.notes,
                "resolved_at": r.resolved_at.isoformat(),
            }
            for r in resolutions
        ]
    }

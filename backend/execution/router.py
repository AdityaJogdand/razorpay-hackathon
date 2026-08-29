"""API routes for execution status and manual triggers."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.database import get_db
from backend.models.enums import ActionStatus, ActionType
from backend.models.tables import Action

router = APIRouter(prefix="/execution", tags=["execution"])


@router.get("/stats")
async def execution_stats(
    merchant_id: str = "merchant_demo_001",
    db: AsyncSession = Depends(get_db),
):
    """Get execution statistics for a merchant."""
    result = await db.execute(
        select(
            Action.action_type,
            Action.status,
            func.count(Action.id),
        )
        .where(Action.merchant_id == merchant_id)
        .group_by(Action.action_type, Action.status)
    )
    rows = result.all()

    stats = {}
    for action_type, status, count in rows:
        key = action_type.value if hasattr(action_type, 'value') else str(action_type)
        if key not in stats:
            stats[key] = {}
        status_key = status.value if hasattr(status, 'value') else str(status)
        stats[key][status_key] = count

    return {"merchant_id": merchant_id, "stats": stats}


@router.get("/actions/{event_id}")
async def get_actions_for_event(
    event_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Get all actions for a failure event."""
    import uuid
    result = await db.execute(
        select(Action)
        .where(Action.failure_event_id == uuid.UUID(event_id))
        .order_by(Action.created_at.asc())
    )
    actions = list(result.scalars().all())

    return [
        {
            "id": str(a.id),
            "action_type": a.action_type.value,
            "status": a.status.value,
            "idempotency_key": a.idempotency_key,
            "scheduled_at": a.scheduled_at.isoformat() if a.scheduled_at else None,
            "executed_at": a.executed_at.isoformat() if a.executed_at else None,
            "retry_number": a.retry_number,
            "outcome": a.outcome,
        }
        for a in actions
    ]

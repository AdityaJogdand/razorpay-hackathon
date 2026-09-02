"""API routes for audit ledger."""

import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.database import get_db
from backend.ledger.service import verify_chain, get_entries_for_entity, get_entry_count

router = APIRouter(prefix="/ledger", tags=["ledger"])


@router.post("/verify")
async def verify_ledger_integrity(
    merchant_id: str = "merch_cloudnine_tech",
    db: AsyncSession = Depends(get_db),
):
    """Walk the hash chain and verify integrity."""
    from backend.models.tables import AuditLedger
    from sqlalchemy import select as sa_select

    result = await verify_chain(db, merchant_id)

    # Get head hash for display
    head_result = await db.execute(
        sa_select(AuditLedger.entry_hash)
        .where(AuditLedger.merchant_id == merchant_id)
        .order_by(AuditLedger.id.desc())
        .limit(1)
    )
    head_hash = head_result.scalar_one_or_none() or "0" * 64
    result["head_hash"] = head_hash
    return result


@router.get("/entries/{entity_id}")
async def get_entity_audit_trail(
    entity_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
):
    """Get the full audit trail for a specific entity."""
    entries = await get_entries_for_entity(db, entity_id)
    return [
        {
            "id": e.id,
            "event_type": e.event_type.value,
            "entity_type": e.entity_type,
            "data": e.data,
            "entry_hash": e.entry_hash[:16] + "...",
            "created_at": e.created_at.isoformat(),
        }
        for e in entries
    ]


@router.get("/count")
async def ledger_count(
    merchant_id: str = "merch_cloudnine_tech",
    db: AsyncSession = Depends(get_db),
):
    """Get total number of ledger entries."""
    count = await get_entry_count(db, merchant_id)
    return {"merchant_id": merchant_id, "count": count}


@router.get("/recent")
async def recent_entries(
    merchant_id: str = "merch_cloudnine_tech",
    limit: int = Query(default=50, le=200),
    db: AsyncSession = Depends(get_db),
):
    """Get most recent ledger entries."""
    from backend.models.tables import AuditLedger
    from sqlalchemy import select as sa_select

    result = await db.execute(
        sa_select(AuditLedger)
        .where(AuditLedger.merchant_id == merchant_id)
        .order_by(AuditLedger.id.desc())
        .limit(limit)
    )
    entries = result.scalars().all()
    return [
        {
            "id": e.id,
            "event_type": e.event_type.value,
            "entity_type": e.entity_type,
            "entity_id": str(e.entity_id),
            "data_summary": _summarize(e.event_type.value, e.data),
            "entry_hash": e.entry_hash[:12],
            "previous_hash": e.previous_hash[:12],
            "created_at": e.created_at.isoformat(),
        }
        for e in entries
    ]


def _summarize(event_type: str, data: dict) -> str:
    """One-line human summary of a ledger entry."""
    if event_type == "CLASSIFICATION":
        return f"Classified as {data.get('failure_class', '?')} ({data.get('confidence', 0):.0%})"
    if event_type == "AGENT_PROPOSAL":
        return f"Agent proposed {data.get('proposed_action', '?')}"
    if event_type == "GUARDRAIL_RESULT":
        status = data.get("status", "?")
        return f"Guardrail {status}" + (f" — {data.get('override_reason', '')}" if status == "overridden" else "")
    if event_type == "ACTION_EXECUTED":
        return f"{data.get('action_type', '?')} executed"
    if event_type == "ACTION_OUTCOME":
        return f"Outcome: {data.get('status', '?')}"
    if event_type == "SUPPRESSION":
        return f"Suppressed: {data.get('reason', '?')}"
    if event_type == "CONFIG_CHANGE":
        return f"Config updated: {data.get('key', '?')}"
    return event_type

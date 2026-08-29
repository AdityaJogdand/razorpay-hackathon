"""API routes for audit ledger."""

import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.database import get_db
from backend.ledger.service import verify_chain, get_entries_for_entity, get_entry_count

router = APIRouter(prefix="/ledger", tags=["ledger"])


@router.post("/verify")
async def verify_ledger_integrity(
    merchant_id: str = "merchant_demo_001",
    db: AsyncSession = Depends(get_db),
):
    """Walk the hash chain and verify integrity."""
    result = await verify_chain(db, merchant_id)
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
    merchant_id: str = "merchant_demo_001",
    db: AsyncSession = Depends(get_db),
):
    """Get total number of ledger entries."""
    count = await get_entry_count(db, merchant_id)
    return {"merchant_id": merchant_id, "count": count}

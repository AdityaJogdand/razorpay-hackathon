"""
Hash-chained append-only audit ledger.

Every triage, plan, suppression, execution, and outcome is recorded.
Each entry's hash includes the previous entry's hash, making tampering detectable.
"""

import hashlib
import json
import uuid
from datetime import datetime, timezone

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.enums import LedgerEventType
from backend.models.tables import AuditLedger

GENESIS_HASH = "0" * 64  # SHA-256 of nothing — first entry's previous_hash


def _compute_hash(previous_hash: str, data: dict, event_type: str, entity_id: str, created_at: str) -> str:
    """Compute SHA-256 hash for a ledger entry, chained to the previous hash."""
    payload = json.dumps({
        "previous_hash": previous_hash,
        "event_type": event_type,
        "entity_id": entity_id,
        "created_at": created_at,
        "data": data,
    }, sort_keys=True, default=str)
    return hashlib.sha256(payload.encode()).hexdigest()


async def append(
    db: AsyncSession,
    merchant_id: str,
    event_type: LedgerEventType,
    entity_id: uuid.UUID,
    entity_type: str,
    data: dict,
) -> AuditLedger:
    """Append a new entry to the hash-chained ledger."""
    # Get the last entry's hash
    result = await db.execute(
        select(AuditLedger.entry_hash)
        .where(AuditLedger.merchant_id == merchant_id)
        .order_by(AuditLedger.id.desc())
        .limit(1)
    )
    last_hash = result.scalar_one_or_none() or GENESIS_HASH

    now = datetime.now(timezone.utc)
    entry_hash = _compute_hash(
        previous_hash=last_hash,
        data=data,
        event_type=event_type.value,
        entity_id=str(entity_id),
        created_at=now.isoformat(),
    )

    entry = AuditLedger(
        merchant_id=merchant_id,
        event_type=event_type,
        entity_id=entity_id,
        entity_type=entity_type,
        data=data,
        previous_hash=last_hash,
        entry_hash=entry_hash,
        created_at=now,
    )
    db.add(entry)
    await db.flush()
    return entry


async def verify_chain(db: AsyncSession, merchant_id: str) -> dict:
    """
    Walk the entire hash chain for a merchant and verify integrity.
    Returns {"valid": bool, "entries_checked": int, "broken_at": int | None}.
    """
    result = await db.execute(
        select(AuditLedger)
        .where(AuditLedger.merchant_id == merchant_id)
        .order_by(AuditLedger.id.asc())
    )
    entries = result.scalars().all()

    if not entries:
        return {"valid": True, "entries_checked": 0, "broken_at": None}

    expected_previous = GENESIS_HASH
    for i, entry in enumerate(entries):
        # Check chain link
        if entry.previous_hash != expected_previous:
            return {"valid": False, "entries_checked": i + 1, "broken_at": entry.id}

        # Recompute and verify entry hash
        recomputed = _compute_hash(
            previous_hash=entry.previous_hash,
            data=entry.data,
            event_type=entry.event_type.value,
            entity_id=str(entry.entity_id),
            created_at=entry.created_at.isoformat(),
        )
        if recomputed != entry.entry_hash:
            return {"valid": False, "entries_checked": i + 1, "broken_at": entry.id}

        expected_previous = entry.entry_hash

    return {"valid": True, "entries_checked": len(entries), "broken_at": None}


async def get_entries_for_entity(
    db: AsyncSession,
    entity_id: uuid.UUID,
) -> list[AuditLedger]:
    """Get all ledger entries for a specific entity (e.g. a failure event)."""
    result = await db.execute(
        select(AuditLedger)
        .where(AuditLedger.entity_id == entity_id)
        .order_by(AuditLedger.id.asc())
    )
    return list(result.scalars().all())


async def get_entry_count(db: AsyncSession, merchant_id: str) -> int:
    """Get total number of ledger entries for a merchant."""
    result = await db.execute(
        select(func.count(AuditLedger.id))
        .where(AuditLedger.merchant_id == merchant_id)
    )
    return result.scalar_one()

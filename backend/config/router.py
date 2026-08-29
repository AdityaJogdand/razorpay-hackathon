"""API routes for config management."""

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.database import get_db
from backend.models.tables import ConfigVersion

router = APIRouter(prefix="/config", tags=["config"])


class KillSwitchRequest(BaseModel):
    enabled: bool


class ConfigUpdateRequest(BaseModel):
    max_retries: int | None = None
    retry_window_hours: int | None = None
    max_contacts: int | None = None
    contact_cooldown_hours: int | None = None
    uplift_threshold: float | None = None
    confidence_threshold: float | None = None
    expire_after_days: int | None = None


@router.post("/kill-switch")
async def toggle_kill_switch(
    body: KillSwitchRequest,
    merchant_id: str = "merchant_demo_001",
    db: AsyncSession = Depends(get_db),
):
    """Toggle the kill switch for a merchant."""
    result = await db.execute(
        select(ConfigVersion)
        .where(ConfigVersion.merchant_id == merchant_id, ConfigVersion.is_active == True)
        .order_by(ConfigVersion.version.desc())
        .limit(1)
    )
    config = result.scalar_one_or_none()

    if config is None:
        config = ConfigVersion(merchant_id=merchant_id, version=1, is_active=True)
        db.add(config)

    # Create new version with kill switch toggled
    new_config = ConfigVersion(
        merchant_id=merchant_id,
        version=config.version + 1,
        max_retries=config.max_retries,
        retry_window_hours=config.retry_window_hours,
        max_contacts=config.max_contacts,
        contact_cooldown_hours=config.contact_cooldown_hours,
        uplift_threshold=config.uplift_threshold,
        confidence_threshold=config.confidence_threshold,
        expire_after_days=config.expire_after_days,
        kill_switch=body.enabled,
        is_active=True,
    )

    # Deactivate old config
    config.is_active = False
    db.add(new_config)
    await db.commit()

    return {"kill_switch": body.enabled, "config_version": new_config.version}


@router.get("/current")
async def get_current_config(
    merchant_id: str = "merchant_demo_001",
    db: AsyncSession = Depends(get_db),
):
    """Get the current active config for a merchant."""
    result = await db.execute(
        select(ConfigVersion)
        .where(ConfigVersion.merchant_id == merchant_id, ConfigVersion.is_active == True)
        .order_by(ConfigVersion.version.desc())
        .limit(1)
    )
    config = result.scalar_one_or_none()

    if config is None:
        return {"message": "no config found", "merchant_id": merchant_id}

    return {
        "merchant_id": config.merchant_id,
        "version": config.version,
        "max_retries": config.max_retries,
        "retry_window_hours": config.retry_window_hours,
        "max_contacts": config.max_contacts,
        "contact_cooldown_hours": config.contact_cooldown_hours,
        "uplift_threshold": config.uplift_threshold,
        "confidence_threshold": config.confidence_threshold,
        "expire_after_days": config.expire_after_days,
        "kill_switch": config.kill_switch,
    }

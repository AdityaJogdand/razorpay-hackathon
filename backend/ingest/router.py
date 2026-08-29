"""API routes for webhook ingest."""

from fastapi import APIRouter, Depends, Request, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.database import get_db
from backend.ingest.schemas import WebhookPayload, IngestResponse
from backend.ingest.service import process_webhook, verify_hmac
from backend.dashboard.ws import notify_dashboard_update

router = APIRouter(prefix="/ingest", tags=["ingest"])


@router.post("/webhook", response_model=IngestResponse)
async def ingest_webhook(
    payload: WebhookPayload,
    db: AsyncSession = Depends(get_db),
):
    """
    Ingest a payment failure webhook.

    Processes: normalize -> classify -> plan -> persist -> audit.
    """
    result = await process_webhook(db, payload)

    if result["message"] == "duplicate":
        raise HTTPException(status_code=409, detail="Duplicate gateway event")

    await notify_dashboard_update("ingest")

    return IngestResponse(
        event_id=result["event_id"],
        failure_class=result["failure_class"],
        classification_source=result["classification_source"],
        classification_confidence=result["classification_confidence"],
        plan_summary=result["plan_summary"],
        message=result["message"],
    )


@router.post("/batch")
async def ingest_batch(
    payloads: list[WebhookPayload],
    db: AsyncSession = Depends(get_db),
):
    """Ingest a batch of failure events (for synthetic data loading)."""
    results = []
    for payload in payloads:
        result = await process_webhook(db, payload)
        results.append(result)
    return {
        "processed": len([r for r in results if r["message"] == "processed"]),
        "duplicates": len([r for r in results if r["message"] == "duplicate"]),
        "total": len(results),
    }

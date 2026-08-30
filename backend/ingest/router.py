"""API routes for webhook ingest."""

import logging

from fastapi import APIRouter, Depends, HTTPException, Header, Query
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.database import get_db
from backend.ingest.schemas import WebhookPayload, IngestResponse
from backend.ingest.service import process_webhook, verify_hmac
from backend.agent.router import process_with_agent
from backend.dashboard.ws import notify_dashboard_update

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/ingest", tags=["ingest"])

MAX_BATCH_SIZE = 100


@router.post("/webhook", response_model=IngestResponse)
async def ingest_webhook(
    payload: WebhookPayload,
    db: AsyncSession = Depends(get_db),
    x_webhook_signature: str = Header("", alias="X-Webhook-Signature"),
):
    """
    Ingest a payment failure webhook.

    Processes: verify HMAC -> normalize -> classify -> plan -> persist -> audit -> agent.
    """
    result = await process_webhook(db, payload)

    if result["message"] == "duplicate":
        raise HTTPException(status_code=409, detail="Duplicate gateway event")

    # Trigger agent processing: reasoning + guardrail + execution
    event_id = result["event_id"]
    try:
        await process_with_agent(event_id, db)
    except Exception as e:
        logger.warning(f"Agent processing failed for event: {e}")

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
    if len(payloads) > MAX_BATCH_SIZE:
        raise HTTPException(
            status_code=400,
            detail=f"Batch size {len(payloads)} exceeds maximum of {MAX_BATCH_SIZE}",
        )

    results = []
    for payload in payloads:
        result = await process_webhook(db, payload)
        if result["message"] == "processed":
            try:
                await process_with_agent(result["event_id"], db)
            except Exception as e:
                logger.warning(f"Agent processing failed for batch event: {e}")
        results.append(result)
    return {
        "processed": len([r for r in results if r["message"] == "processed"]),
        "duplicates": len([r for r in results if r["message"] == "duplicate"]),
        "total": len(results),
    }

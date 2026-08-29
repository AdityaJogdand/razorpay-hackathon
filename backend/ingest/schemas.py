"""Pydantic schemas for webhook ingest."""

from datetime import datetime
from pydantic import BaseModel, Field


class WebhookPayload(BaseModel):
    """Raw webhook payload from the payment gateway."""
    gateway_event_id: str
    merchant_id: str = "merchant_demo_001"
    transaction_id: str
    subscription_id: str | None = None
    customer_id: str
    customer_email: str | None = None
    instrument_type: str  # CARD, UPI, EMANDATE, NETBANKING, WALLET
    instrument_token: str
    error_code: str
    error_description: str | None = None
    amount_paise: int = Field(gt=0)
    currency: str = "INR"
    failed_at: datetime


class IngestResponse(BaseModel):
    """Response after ingesting a failure event."""
    event_id: str
    failure_class: str
    classification_source: str
    classification_confidence: float
    plan_summary: dict
    message: str

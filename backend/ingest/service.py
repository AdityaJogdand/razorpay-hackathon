"""
Ingest + normalization + classification + planning pipeline.

F1: Accept webhook, deduplicate, persist.
F2: Normalize raw error code to internal taxonomy.
F3: Classify via rules or LLM.
F4+F7: Produce recovery plan with stopping rules.
F9: Record every decision in the audit ledger.
"""

import hashlib
import hmac
import logging
import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.config import settings
from backend.models.enums import (
    FailureClass, InstrumentType, LedgerEventType, ActionType, ActionStatus,
)
from backend.models.tables import (
    FailureEvent, RecoveryPlan, Action, Suppression, ConfigVersion,
)
from backend.classifier.service import classify
from backend.classifier.taxonomy import normalize_error_code
from backend.policy.engine import (
    create_recovery_plan, PolicyConfig, CustomerContext, PlannedAction,
)
from backend.ledger.service import append as ledger_append
from backend.ingest.schemas import WebhookPayload

logger = logging.getLogger(__name__)


def verify_hmac(payload_bytes: bytes, signature: str) -> bool:
    """Verify HMAC-SHA256 signature from the gateway."""
    expected = hmac.new(
        settings.webhook_secret.encode(),
        payload_bytes,
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(expected, signature)


async def get_or_create_config(db: AsyncSession, merchant_id: str) -> ConfigVersion:
    """Get the active config for a merchant, creating defaults if none exists."""
    result = await db.execute(
        select(ConfigVersion)
        .where(ConfigVersion.merchant_id == merchant_id, ConfigVersion.is_active == True)
        .order_by(ConfigVersion.version.desc())
        .limit(1)
    )
    config = result.scalar_one_or_none()

    if config is None:
        config = ConfigVersion(
            merchant_id=merchant_id,
            version=1,
            max_retries=3,
            retry_window_hours=72,
            max_contacts=3,
            contact_cooldown_hours=24,
            uplift_threshold=0.05,
            confidence_threshold=0.7,
            expire_after_days=7,
            kill_switch=False,
            is_active=True,
        )
        db.add(config)
        await db.flush()
    return config


async def process_webhook(db: AsyncSession, payload: WebhookPayload) -> dict:
    """
    Full ingest pipeline: normalize -> classify -> plan -> persist -> audit.

    Returns a summary dict for the API response.
    """
    # --- F1: Deduplication ---
    existing = await db.execute(
        select(FailureEvent.id)
        .where(
            FailureEvent.merchant_id == payload.merchant_id,
            FailureEvent.gateway_event_id == payload.gateway_event_id,
        )
    )
    if existing.scalar_one_or_none() is not None:
        return {"message": "duplicate", "event_id": None}

    # --- F2: Normalize ---
    instrument_type = InstrumentType(payload.instrument_type)
    normalized_code = normalize_error_code(payload.error_code)

    # --- F3: Classify ---
    failure_class, classification_source, confidence = await classify(
        raw_error_code=payload.error_code,
        raw_error_description=payload.error_description,
    )

    # --- Persist failure event ---
    event_id = uuid.uuid4()
    event = FailureEvent(
        id=event_id,
        merchant_id=payload.merchant_id,
        gateway_event_id=payload.gateway_event_id,
        transaction_id=payload.transaction_id,
        subscription_id=payload.subscription_id,
        customer_id=payload.customer_id,
        customer_email=payload.customer_email,
        instrument_type=instrument_type,
        instrument_token=payload.instrument_token,
        raw_error_code=payload.error_code,
        raw_error_description=payload.error_description,
        normalized_code=normalized_code,
        failure_class=failure_class,
        classification_source=classification_source,
        classification_confidence=confidence,
        amount_paise=payload.amount_paise,
        currency=payload.currency,
        failed_at=payload.failed_at,
        ingested_at=datetime.now(timezone.utc),
    )
    db.add(event)
    await db.flush()

    # --- F9: Audit — triage ---
    await ledger_append(db, payload.merchant_id, LedgerEventType.TRIAGE, event_id, "failure_event", {
        "failure_class": failure_class.value,
        "classification_source": classification_source,
        "confidence": confidence,
        "raw_error_code": payload.error_code,
        "normalized_code": normalized_code,
    })

    # --- F4+F7: Policy engine ---
    config_row = await get_or_create_config(db, payload.merchant_id)
    policy_config = PolicyConfig(
        version=config_row.version,
        max_retries=config_row.max_retries,
        retry_window_hours=config_row.retry_window_hours,
        max_contacts=config_row.max_contacts,
        contact_cooldown_hours=config_row.contact_cooldown_hours,
        uplift_threshold=config_row.uplift_threshold,
        confidence_threshold=config_row.confidence_threshold,
        expire_after_days=config_row.expire_after_days,
        kill_switch=config_row.kill_switch,
    )

    # Build customer context (in production, fetched from DB; here from payload + defaults)
    customer_ctx = CustomerContext(
        customer_id=payload.customer_id,
        email=payload.customer_email,
        tenure_days=90,  # placeholder — will be enriched from synthetic data
        past_failures=0,
        past_successes=5,
        opted_out=False,
        prior_contacts_in_window=0,
        prior_retries_for_txn=0,
    )

    plan = create_recovery_plan(
        failure_event_id=event_id,
        merchant_id=payload.merchant_id,
        failure_class=failure_class.value,
        classification_confidence=confidence,
        config=policy_config,
        customer=customer_ctx,
        failed_at=payload.failed_at,
        amount_paise=payload.amount_paise,
        transaction_id=payload.transaction_id,
    )

    # --- Persist recovery plan ---
    plan_id = uuid.uuid4()
    plan_data = {
        "actions": [
            {
                "action_type": a.action_type,
                "scheduled_offset_hours": a.scheduled_offset_hours,
                "retry_number": a.retry_number,
                "idempotency_key": a.idempotency_key,
            }
            for a in plan.actions
        ],
        "suppressions": [
            {
                "action_type": s.action_type,
                "rule_name": s.rule_name,
                "rule_version": s.rule_version,
                "reason": s.reason,
            }
            for s in plan.suppressions
        ],
    }
    plan_row = RecoveryPlan(
        id=plan_id,
        failure_event_id=event_id,
        merchant_id=payload.merchant_id,
        config_version=config_row.version,
        policy_version=plan.policy_version,
        plan_data=plan_data,
    )
    db.add(plan_row)
    await db.flush()

    # --- F9: Audit — plan created ---
    await ledger_append(db, payload.merchant_id, LedgerEventType.PLAN_CREATED, event_id, "recovery_plan", {
        "plan_id": str(plan_id),
        "config_version": config_row.version,
        "policy_version": plan.policy_version,
        "num_actions": len(plan.actions),
        "num_suppressions": len(plan.suppressions),
    })

    # --- Persist individual actions ---
    for planned_action in plan.actions:
        from datetime import timedelta
        scheduled_at = payload.failed_at + timedelta(
            hours=planned_action.scheduled_offset_hours
        )
        action_row = Action(
            id=uuid.uuid4(),
            failure_event_id=event_id,
            recovery_plan_id=plan_id,
            merchant_id=payload.merchant_id,
            action_type=ActionType(planned_action.action_type),
            status=ActionStatus.SCHEDULED,
            idempotency_key=planned_action.idempotency_key,
            scheduled_at=scheduled_at,
            retry_number=planned_action.retry_number,
            estimated_success_prob=planned_action.estimated_success_prob,
            estimated_uplift=planned_action.estimated_uplift,
        )
        db.add(action_row)

        await ledger_append(db, payload.merchant_id, LedgerEventType.ACTION_SCHEDULED, event_id, "action", {
            "action_type": planned_action.action_type,
            "idempotency_key": planned_action.idempotency_key,
            "scheduled_offset_hours": planned_action.scheduled_offset_hours,
        })

    # --- Persist suppressions ---
    for suppression in plan.suppressions:
        supp_row = Suppression(
            id=uuid.uuid4(),
            failure_event_id=event_id,
            merchant_id=payload.merchant_id,
            action_type=ActionType(suppression.action_type) if suppression.action_type != "ALL" else ActionType.RETRY,
            rule_name=suppression.rule_name,
            rule_version=suppression.rule_version,
            reason=suppression.reason,
        )
        db.add(supp_row)

        await ledger_append(db, payload.merchant_id, LedgerEventType.SUPPRESSION, event_id, "suppression", {
            "action_type": suppression.action_type,
            "rule_name": suppression.rule_name,
            "reason": suppression.reason,
        })

    await db.commit()

    return {
        "event_id": str(event_id),
        "failure_class": failure_class.value,
        "classification_source": classification_source,
        "classification_confidence": confidence,
        "plan_summary": {
            "actions": len(plan.actions),
            "suppressions": len(plan.suppressions),
            "action_types": [a.action_type for a in plan.actions],
            "suppression_rules": [s.rule_name for s in plan.suppressions],
        },
        "message": "processed",
    }

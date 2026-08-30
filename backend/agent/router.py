"""
Agent API — the full agentic pipeline.

POST /agent/process/{event_id}
  1. Reads the failure event from DB
  2. Calls the LLM agent to reason and propose
  3. Runs the guardrail engine to validate
  4. Executes the approved action
  5. Logs everything to the audit ledger

This is the Phase 3 entrypoint — replaces the deterministic-only policy engine
with agent reasoning + guardrail validation.
"""

import uuid
import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.database import get_db
from backend.models.enums import ActionType, ActionStatus, LedgerEventType
from backend.models.tables import FailureEvent, Action, RecoveryPlan, ConfigVersion, Suppression
from backend.agent.service import get_agent_proposal
from backend.guardrail.engine import validate_proposal
from backend.execution.service import execute_action
from backend.ledger.service import append as ledger_append
from backend.dashboard.ws import notify_dashboard_update

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/agent", tags=["agent"])


@router.post("/process/{event_id}")
async def process_with_agent(
    event_id: str,
    db: AsyncSession = Depends(get_db),
):
    """
    Run the full agent pipeline on a failure event.

    Agent reasons → Guardrail validates → Execution delivers.
    """
    # ── Load failure event ──
    event_uuid = uuid.UUID(event_id)
    result = await db.execute(
        select(FailureEvent).where(FailureEvent.id == event_uuid)
    )
    event = result.scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="Failure event not found")

    # ── Load config ──
    config_result = await db.execute(
        select(ConfigVersion)
        .where(ConfigVersion.merchant_id == event.merchant_id, ConfigVersion.is_active == True)
        .order_by(ConfigVersion.version.desc())
        .limit(1)
    )
    config = config_result.scalar_one_or_none()
    if not config:
        raise HTTPException(status_code=404, detail="No config found for merchant")

    # ── Count prior agent-driven retries/contacts for this txn ──
    # Only count actions without a recovery_plan_id (agent-driven, not policy engine)
    prior_actions = await db.execute(
        select(Action).where(
            Action.failure_event_id == event_uuid,
            Action.recovery_plan_id.is_(None),
        )
    )
    actions_list = list(prior_actions.scalars().all())
    prior_retries = sum(1 for a in actions_list if a.action_type == ActionType.RETRY)
    prior_contacts = sum(
        1 for a in actions_list
        if a.action_type in (ActionType.CONTACT_EMAIL, ActionType.REAUTH_REQUEST)
    )

    # ── Step 1: Agent proposes ──
    proposal = await get_agent_proposal(
        failure_event_id=str(event.id),
        transaction_id=event.transaction_id,
        merchant_id=event.merchant_id,
        customer_id=event.customer_id,
        customer_email=event.customer_email,
        instrument_type=event.instrument_type.value,
        instrument_token=event.instrument_token,
        error_code=event.raw_error_code,
        error_description=event.raw_error_description,
        amount_paise=event.amount_paise,
        failed_at=event.failed_at.isoformat(),
        failure_class=event.failure_class.value,
        classification_confidence=event.classification_confidence or 0.0,
        classification_source=event.classification_source or "RULES",
        prior_retries=prior_retries,
        prior_contacts=prior_contacts,
        max_retries=config.max_retries,
        retry_window_hours=config.retry_window_hours,
        max_contacts=config.max_contacts,
        contact_cooldown_hours=config.contact_cooldown_hours,
        kill_switch=config.kill_switch,
    )

    # ── Audit: log agent proposal ──
    await ledger_append(
        db, event.merchant_id, LedgerEventType.AGENT_PROPOSAL,
        event.id, "agent_proposal",
        {
            "proposed_action": proposal.proposed_action,
            "reasoning": proposal.reasoning,
            "confidence": proposal.confidence,
            "retry_schedule": proposal.retry_schedule,
            "has_email_draft": proposal.email_draft is not None,
            "email_draft": proposal.email_draft,
        },
    )

    # ── Step 2: Guardrail validates ──
    guardrail_result = validate_proposal(
        proposal=proposal,
        failure_class=event.failure_class.value,
        classification_confidence=event.classification_confidence or 0.0,
        confidence_threshold=config.confidence_threshold,
        max_retries=config.max_retries,
        retry_window_hours=config.retry_window_hours,
        max_contacts=config.max_contacts,
        contact_cooldown_hours=config.contact_cooldown_hours,
        prior_retries=prior_retries,
        prior_contacts=prior_contacts,
        opted_out=False,  # would come from customer profile in production
        has_email=bool(event.customer_email),
        kill_switch=config.kill_switch,
    )

    # ── Audit: log guardrail result ──
    await ledger_append(
        db, event.merchant_id, LedgerEventType.GUARDRAIL_RESULT,
        event.id, "guardrail_result",
        {
            "approved": guardrail_result.approved,
            "overridden": guardrail_result.overridden,
            "original_action": proposal.proposed_action,
            "final_action": guardrail_result.final_action,
            "override_reason": guardrail_result.override_reason,
            "checks": [
                {
                    "rule": c.rule_name,
                    "passed": c.passed,
                    "detail": c.detail,
                }
                for c in guardrail_result.checks
            ],
        },
    )

    # ── Log suppressions if overridden ──
    if guardrail_result.overridden:
        supp = Suppression(
            id=uuid.uuid4(),
            failure_event_id=event.id,
            merchant_id=event.merchant_id,
            action_type=ActionType(proposal.proposed_action) if proposal.proposed_action in [e.value for e in ActionType] else ActionType.RETRY,
            rule_name="guardrail_override",
            rule_version=1,
            reason=guardrail_result.override_reason or "Guardrail override",
        )
        db.add(supp)
        await db.flush()

        await ledger_append(
            db, event.merchant_id, LedgerEventType.SUPPRESSION,
            event.id, "suppression",
            {
                "original_action": proposal.proposed_action,
                "override_reason": guardrail_result.override_reason,
            },
        )

    # ── Step 3: Create and execute action ──
    final_action_type = guardrail_result.final_action
    now = datetime.now(timezone.utc)

    execution_results = []

    if final_action_type == "RETRY" and guardrail_result.final_retry_schedule:
        # Schedule multiple retries
        for i, offset_hours in enumerate(guardrail_result.final_retry_schedule):
            retry_num = prior_retries + i + 1
            action_row = Action(
                id=uuid.uuid4(),
                failure_event_id=event.id,
                recovery_plan_id=None,  # Agent-driven, no plan row
                merchant_id=event.merchant_id,
                action_type=ActionType.RETRY,
                status=ActionStatus.SCHEDULED,
                idempotency_key=f"{event.id}:{event.transaction_id}:AGENT_RETRY:{retry_num}",
                scheduled_at=now + timedelta(hours=offset_hours),
                retry_number=retry_num,
                estimated_success_prob=proposal.confidence,
            )
            db.add(action_row)
            await db.flush()

            # Execute the first retry immediately for demo
            if i == 0:
                exec_result = await execute_action(
                    db=db,
                    action=action_row,
                    transaction_id=event.transaction_id,
                    amount_paise=event.amount_paise,
                    instrument_token=event.instrument_token,
                    merchant_id=event.merchant_id,
                )
                execution_results.append({
                    "action_type": "RETRY",
                    "retry_number": retry_num,
                    "status": exec_result.status,
                    "detail": exec_result.detail,
                })

    elif final_action_type in ("CONTACT_EMAIL", "REAUTH_REQUEST"):
        # Generate fallback email if guardrail overrode to email but agent didn't draft one
        email_to_send = guardrail_result.final_email_draft or proposal.email_draft
        if not email_to_send and event.customer_email:
            amount_rupees = event.amount_paise / 100
            email_to_send = {
                "subject": f"Payment update needed for {event.merchant_id}",
                "body": (
                    f"Hi,\n\n"
                    f"Your recent payment of ₹{amount_rupees:,.0f} could not be processed.\n\n"
                    f"Please update your payment method to continue your service.\n\n"
                    f"Best regards,\n{event.merchant_id} Billing"
                ),
            }

        at = ActionType.CONTACT_EMAIL if final_action_type == "CONTACT_EMAIL" else ActionType.REAUTH_REQUEST
        contact_num = prior_contacts + 1
        action_row = Action(
            id=uuid.uuid4(),
            failure_event_id=event.id,
            recovery_plan_id=None,
            merchant_id=event.merchant_id,
            action_type=at,
            status=ActionStatus.SCHEDULED,
            idempotency_key=f"{event.id}:{event.transaction_id}:AGENT_{final_action_type}:{contact_num}",
            scheduled_at=now,
        )
        db.add(action_row)
        await db.flush()

        exec_result = await execute_action(
            db=db,
            action=action_row,
            email_draft=email_to_send,
            customer_email=event.customer_email,
            merchant_id=event.merchant_id,
        )
        execution_results.append({
            "action_type": final_action_type,
            "status": exec_result.status,
            "detail": exec_result.detail,
        })

    elif final_action_type == "ESCALATE_HUMAN":
        action_row = Action(
            id=uuid.uuid4(),
            failure_event_id=event.id,
            recovery_plan_id=None,
            merchant_id=event.merchant_id,
            action_type=ActionType.ESCALATE_HUMAN,
            status=ActionStatus.SCHEDULED,
            idempotency_key=f"{event.id}:{event.transaction_id}:AGENT_ESCALATE:{uuid.uuid4().hex[:8]}",
            scheduled_at=now,
        )
        db.add(action_row)
        await db.flush()

        exec_result = await execute_action(
            db=db,
            action=action_row,
            merchant_id=event.merchant_id,
        )
        execution_results.append({
            "action_type": "ESCALATE_HUMAN",
            "status": exec_result.status,
            "detail": exec_result.detail,
        })

    await db.commit()
    await notify_dashboard_update("agent_processed")

    return {
        "event_id": str(event.id),
        "transaction_id": event.transaction_id,
        "failure_class": event.failure_class.value,
        "agent": {
            "proposed_action": proposal.proposed_action,
            "reasoning": proposal.reasoning,
            "confidence": proposal.confidence,
            "retry_schedule": proposal.retry_schedule,
            "has_email_draft": proposal.email_draft is not None,
        },
        "guardrail": {
            "approved": guardrail_result.approved,
            "overridden": guardrail_result.overridden,
            "final_action": guardrail_result.final_action,
            "override_reason": guardrail_result.override_reason,
            "checks": [
                {"rule": c.rule_name, "passed": c.passed, "detail": c.detail}
                for c in guardrail_result.checks
            ],
        },
        "execution": execution_results,
    }


@router.post("/batch-process")
async def batch_process_with_agent(
    merchant_id: str = "merchant_demo_001",
    limit: int = 10,
    db: AsyncSession = Depends(get_db),
):
    """
    Run the agent pipeline on unprocessed failure events.
    Useful for demo: processes a batch and shows agent reasoning + guardrail corrections.
    """
    # Find events that don't have agent-driven actions yet
    result = await db.execute(
        select(FailureEvent)
        .where(FailureEvent.merchant_id == merchant_id)
        .order_by(FailureEvent.failed_at.desc())
        .limit(limit)
    )
    events = list(result.scalars().all())

    results = []
    for event in events:
        try:
            # Process each event through the agent pipeline
            single_result = await process_with_agent(str(event.id), db)
            results.append(single_result)
        except Exception as e:
            logger.error(f"Agent processing failed for {event.id}: {e}")
            results.append({
                "event_id": str(event.id),
                "error": str(e),
            })

    return {
        "processed": len(results),
        "results": results,
    }

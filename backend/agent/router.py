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

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.database import get_db
from backend.models.enums import ActionType, ActionStatus, LedgerEventType
from backend.models.tables import FailureEvent, Action, ConfigVersion, Suppression, AuditLedger
from backend.agent.service import get_agent_proposal
from backend.core.security import validate_uuid
from backend.guardrail.shacl_engine import validate_proposal_shacl, get_shacl_report
from backend.execution.service import execute_action
from backend.ledger.service import append as ledger_append
from backend.dashboard.ws import notify_dashboard_update

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/agent", tags=["agent"])


class EmailDraftUpdate(BaseModel):
    subject: str = Field(min_length=1, max_length=255)
    body: str = Field(min_length=1, max_length=10_000)


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
    validate_uuid(event_id)
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

    # ── Step 2: SHACL Guardrail validates ──
    guardrail_kwargs = dict(
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
        decline_code=event.raw_error_code or "",
        instrument_type=event.instrument_type.value if event.instrument_type else "",
        amount_paise=event.amount_paise,
    )
    guardrail_result = validate_proposal_shacl(**guardrail_kwargs)

    # Get the raw SHACL report for audit
    shacl_report = get_shacl_report(**guardrail_kwargs)

    # ── Audit: log guardrail result with SHACL report ──
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
            "shacl": {
                "conforms": shacl_report["conforms"],
                "engine": shacl_report["engine"],
                "ontology": shacl_report["ontology"],
                "shapes": shacl_report["shapes"],
                "data_graph_turtle": shacl_report["data_graph_turtle"],
                "results_text": shacl_report["results_text"],
            },
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
            status=ActionStatus.PENDING_APPROVAL,
            idempotency_key=f"{event.id}:{event.transaction_id}:AGENT_{final_action_type}:{contact_num}",
            scheduled_at=now,
            outcome={
                "email_draft": email_to_send,
                "customer_email": event.customer_email,
                "amount_paise": event.amount_paise,
            },
        )
        db.add(action_row)
        await db.flush()

        # Do NOT auto-execute email — requires human approval via /agent/approve-email
        execution_results.append({
            "action_type": final_action_type,
            "status": "PENDING_APPROVAL",
            "detail": "Email draft created — awaiting human approval",
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
            "shacl": {
                "conforms": shacl_report["conforms"],
                "engine": "pyshacl",
                "ontology": "RDF/OWL",
                "shapes": "SHACL",
            },
        },
        "execution": execution_results,
    }


@router.put("/email-draft/{action_id}")
async def update_email_draft(
    action_id: str,
    draft: EmailDraftUpdate,
    db: AsyncSession = Depends(get_db),
):
    """Update a pending email draft before a reviewer approves it."""
    validate_uuid(action_id)
    result = await db.execute(select(Action).where(Action.id == uuid.UUID(action_id)))
    action = result.scalar_one_or_none()
    if not action:
        raise HTTPException(status_code=404, detail="Action not found")
    if action.status not in (ActionStatus.PENDING_APPROVAL, ActionStatus.SCHEDULED):
        raise HTTPException(status_code=400, detail=f"Action is {action.status.value}, cannot edit")
    if action.action_type not in (ActionType.CONTACT_EMAIL, ActionType.REAUTH_REQUEST):
        raise HTTPException(status_code=400, detail="Action is not an email")

    outcome = dict(action.outcome or {})
    outcome["email_draft"] = {"subject": draft.subject.strip(), "body": draft.body.strip()}
    action.outcome = outcome
    await db.commit()
    await notify_dashboard_update("email_draft_updated")

    return {"action_id": str(action.id), "subject": outcome["email_draft"]["subject"], "body": outcome["email_draft"]["body"]}


@router.post("/approve-email/{action_id}")
async def approve_email(
    action_id: str,
    db: AsyncSession = Depends(get_db),
):
    """
    Human approves a pending email action — actually send the email now.
    """
    validate_uuid(action_id)
    action_uuid = uuid.UUID(action_id)
    result = await db.execute(
        select(Action).where(Action.id == action_uuid)
    )
    action = result.scalar_one_or_none()
    if not action:
        raise HTTPException(status_code=404, detail="Action not found")
    if action.status not in (ActionStatus.PENDING_APPROVAL, ActionStatus.SCHEDULED):
        raise HTTPException(status_code=400, detail=f"Action is {action.status.value}, cannot approve")

    # Extract stored email info from outcome
    stored = action.outcome or {}
    email_draft = stored.get("email_draft")
    customer_email = stored.get("customer_email")
    amount_paise = stored.get("amount_paise", 0)

    # Fallback: if no email data in outcome, look up from the event and ledger
    if not customer_email:
        event_result = await db.execute(
            select(FailureEvent).where(FailureEvent.id == action.failure_event_id)
        )
        event = event_result.scalar_one_or_none()
        if event:
            customer_email = event.customer_email
            amount_paise = event.amount_paise
            if not email_draft:
                # Try to get from agent proposal in ledger
                ledger_result = await db.execute(
                    select(AuditLedger).where(
                        AuditLedger.entity_id == event.id,
                        AuditLedger.event_type == LedgerEventType.AGENT_PROPOSAL,
                    ).order_by(AuditLedger.created_at.desc()).limit(1)
                )
                ledger_entry = ledger_result.scalar_one_or_none()
                if ledger_entry and ledger_entry.data:
                    email_draft = ledger_entry.data.get("email_draft")
                # Final fallback
                if not email_draft:
                    amount_rupees = amount_paise / 100
                    email_draft = {
                        "subject": f"Payment update needed — {event.merchant_id}",
                        "body": f"Hi,\n\nYour recent payment of ₹{amount_rupees:,.0f} could not be processed.\n\nPlease update your payment method to continue your service.\n\nBest regards,\n{event.merchant_id} Billing",
                    }

    # Execute the email
    action.status = ActionStatus.SCHEDULED
    await db.flush()

    exec_result = await execute_action(
        db=db,
        action=action,
        email_draft=email_draft,
        customer_email=customer_email,
        merchant_id=action.merchant_id,
        amount_paise=amount_paise,
    )
    await db.commit()
    await notify_dashboard_update("email_approved")

    return {
        "action_id": str(action.id),
        "status": exec_result.status,
        "detail": exec_result.detail,
    }


@router.post("/deny-email/{action_id}")
async def deny_email(
    action_id: str,
    db: AsyncSession = Depends(get_db),
):
    """
    Human denies a pending email action.
    """
    validate_uuid(action_id)
    action_uuid = uuid.UUID(action_id)
    result = await db.execute(
        select(Action).where(Action.id == action_uuid)
    )
    action = result.scalar_one_or_none()
    if not action:
        raise HTTPException(status_code=404, detail="Action not found")
    if action.status not in (ActionStatus.PENDING_APPROVAL, ActionStatus.SCHEDULED):
        raise HTTPException(status_code=400, detail=f"Action is {action.status.value}, cannot deny")

    action.status = ActionStatus.DENIED
    action.executed_at = datetime.now(timezone.utc)
    await db.commit()
    await notify_dashboard_update("email_denied")

    return {
        "action_id": str(action.id),
        "status": "DENIED",
        "detail": "Email denied by human review",
    }


@router.post("/batch-process")
async def batch_process_with_agent(
    merchant_id: str = "merchant_demo_001",
    limit: int = Query(10, le=50),
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
            logger.error(f"Agent processing failed for event: {e}")
            results.append({
                "event_id": str(event.id),
                "error": "Processing failed",
            })

    return {
        "processed": len(results),
        "results": results,
    }

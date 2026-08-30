"""
OPE API — Off-Policy Evaluation endpoints.

Evaluates the agent's recovery performance against the stochastic baseline
using the holdout set's frozen ground truth.
"""

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.database import get_db
from backend.models.enums import ActionType, ActionStatus, LedgerEventType
from backend.models.tables import FailureEvent, Action, AuditLedger
from backend.ope.estimators import (
    load_dataset,
    evaluate_ips,
    evaluate_doubly_robust,
)

router = APIRouter(prefix="/ope", tags=["ope"])


@router.get("/evaluate")
async def evaluate(
    method: str = Query("dr", regex="^(ips|dr)$"),
    split: str = Query("holdout", regex="^(dev|holdout)$"),
    db: AsyncSession = Depends(get_db),
):
    """
    Run off-policy evaluation.

    Compares agent decisions (from DB) against baseline policy
    using ground truth outcomes from the synthetic dataset.
    """
    # Load ground truth
    transactions = load_dataset(split)

    # Build a map of what the agent actually did for each transaction
    txn_ids = [t["transaction_id"] for t in transactions]

    # Get failure events for these transactions
    events_result = await db.execute(
        select(FailureEvent)
        .where(FailureEvent.transaction_id.in_(txn_ids))
    )
    events = {e.transaction_id: e for e in events_result.scalars().all()}

    # Get agent proposals from ledger
    event_ids = [e.id for e in events.values()]
    proposals_result = await db.execute(
        select(AuditLedger)
        .where(
            AuditLedger.entity_id.in_(event_ids),
            AuditLedger.event_type == LedgerEventType.AGENT_PROPOSAL,
        )
        .order_by(AuditLedger.created_at.desc())
    )
    proposals_by_event = {}
    for entry in proposals_result.scalars().all():
        key = str(entry.entity_id)
        if key not in proposals_by_event:
            proposals_by_event[key] = entry.data

    # Get guardrail results
    guardrails_result = await db.execute(
        select(AuditLedger)
        .where(
            AuditLedger.entity_id.in_(event_ids),
            AuditLedger.event_type == LedgerEventType.GUARDRAIL_RESULT,
        )
        .order_by(AuditLedger.created_at.desc())
    )
    guardrails_by_event = {}
    for entry in guardrails_result.scalars().all():
        key = str(entry.entity_id)
        if key not in guardrails_by_event:
            guardrails_by_event[key] = entry.data

    # Get executed actions
    actions_result = await db.execute(
        select(Action)
        .where(Action.failure_event_id.in_(event_ids))
    )
    actions_by_event: dict[str, list] = {}
    for a in actions_result.scalars().all():
        key = str(a.failure_event_id)
        actions_by_event.setdefault(key, []).append(a)

    # Build agent_actions map keyed by transaction_id
    agent_actions: dict[str, dict] = {}
    for txn_id, event in events.items():
        eid = str(event.id)
        proposal = proposals_by_event.get(eid, {})
        guardrail = guardrails_by_event.get(eid, {})
        actions = actions_by_event.get(eid, [])

        # What did the agent actually do?
        executed_types = set()
        succeeded = False
        for a in actions:
            if a.status in (ActionStatus.SUCCEEDED, ActionStatus.FAILED, ActionStatus.EXECUTING):
                executed_types.add(a.action_type.value)
            if a.status == ActionStatus.SUCCEEDED:
                succeeded = True

        # Fallback to scheduled actions if nothing executed
        if not executed_types:
            for a in actions:
                if a.status == ActionStatus.SCHEDULED:
                    executed_types.add(a.action_type.value)

        agent_actions[txn_id] = {
            "action": " ".join(executed_types) if executed_types else proposal.get("proposed_action", ""),
            "guardrail_agreed": not guardrail.get("overridden", False),
            "succeeded": succeeded,
        }

    # Only evaluate transactions that were actually processed by the agent
    transactions = [t for t in transactions if t["transaction_id"] in agent_actions]

    if not transactions:
        return {
            "method": "Doubly Robust" if method == "dr" else "IPS",
            "n_transactions": 0,
            "agent_recovery_rate": 0,
            "baseline_recovery_rate": 0,
            "incremental_recovery_paise": 0,
            "ci_lower_paise": 0,
            "ci_upper_paise": 0,
            "attempts_saved": 0,
            "contacts_suppressed": 0,
            "agreement_rate": 0,
            "agent_attempts_per_recovery": 0,
            "baseline_attempts_per_recovery": 0,
            "agent_contacts": 0,
            "baseline_contacts": 0,
            "avg_time_to_recovery_agent_hours": 0,
            "avg_time_to_recovery_baseline_hours": 0,
            "by_class": {},
        }

    # Run estimator
    if method == "ips":
        result = evaluate_ips(transactions, agent_actions)
    else:
        result = evaluate_doubly_robust(transactions, agent_actions)

    return {
        "method": result.method,
        "n_transactions": result.n_transactions,
        "agent_recovery_rate": result.agent_recovery_rate,
        "baseline_recovery_rate": result.baseline_recovery_rate,
        "incremental_recovery_paise": result.incremental_recovery_paise,
        "ci_lower_paise": result.ci_lower_paise,
        "ci_upper_paise": result.ci_upper_paise,
        "attempts_saved": result.attempts_saved,
        "contacts_suppressed": result.contacts_suppressed,
        "agreement_rate": result.agreement_rate,
        "agent_attempts_per_recovery": result.agent_attempts_per_recovery,
        "baseline_attempts_per_recovery": result.baseline_attempts_per_recovery,
        "agent_contacts": result.agent_contacts,
        "baseline_contacts": result.baseline_contacts,
        "avg_time_to_recovery_agent_hours": result.avg_time_to_recovery_agent_hours,
        "avg_time_to_recovery_baseline_hours": result.avg_time_to_recovery_baseline_hours,
        "by_class": result.by_class,
    }

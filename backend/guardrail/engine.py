"""
Guardrail Engine — validates every agent proposal against hard rules.

The agent proposes, the guardrail disposes. This is the safety layer that ensures
no LLM hallucination can cause a forbidden action (retry a dead card, spam a customer,
violate opt-out, etc.).

Every override is logged — showing the agent being corrected is a demo moment.
"""

import logging
from dataclasses import dataclass, field

from backend.agent.service import AgentProposal

logger = logging.getLogger(__name__)

GUARDRAIL_VERSION = 1


@dataclass
class GuardrailCheck:
    """Result of a single guardrail rule check."""
    rule_name: str
    rule_version: int
    passed: bool
    detail: str | None = None


@dataclass
class GuardrailResult:
    """Complete guardrail validation result for an agent proposal."""
    proposal: AgentProposal
    approved: bool
    final_action: str  # May differ from proposal if overridden
    checks: list[GuardrailCheck] = field(default_factory=list)
    overridden: bool = False
    override_reason: str | None = None
    final_retry_schedule: list[float] | None = None
    final_email_draft: dict | None = None


def validate_proposal(
    proposal: AgentProposal,
    failure_class: str,
    classification_confidence: float,
    confidence_threshold: float = 0.7,
    max_retries: int = 3,
    retry_window_hours: int = 72,
    max_contacts: int = 3,
    contact_cooldown_hours: int = 24,
    prior_retries: int = 0,
    prior_contacts: int = 0,
    opted_out: bool = False,
    has_email: bool = True,
    kill_switch: bool = False,
) -> GuardrailResult:
    """
    Validate an agent proposal against deterministic guardrails.

    Pure function — no I/O, no side effects. Returns a GuardrailResult
    that may override the agent's proposed action.
    """
    checks: list[GuardrailCheck] = []
    overridden = False
    override_reason = None
    final_action = proposal.proposed_action
    final_retry_schedule = proposal.retry_schedule
    final_email_draft = proposal.email_draft

    # ── Rule 1: Hard decline — NEVER retry ──
    if failure_class == "HARD" and proposal.proposed_action == "RETRY":
        checks.append(GuardrailCheck(
            rule_name="hard_no_retry",
            rule_version=GUARDRAIL_VERSION,
            passed=False,
            detail=f"Agent proposed RETRY for HARD decline. Hard declines must never be retried.",
        ))
        overridden = True
        override_reason = (
            f"Agent proposed RETRY on HARD decline ({proposal.failure_class}). "
            f"Guardrail enforced no-retry policy. Action changed to CONTACT_EMAIL."
        )
        final_action = "CONTACT_EMAIL" if has_email and not opted_out else "ESCALATE_HUMAN"
        final_retry_schedule = None
    else:
        checks.append(GuardrailCheck(
            rule_name="hard_no_retry",
            rule_version=GUARDRAIL_VERSION,
            passed=True,
        ))

    # ── Rule 2: Mandate — NEVER retry ──
    if failure_class == "MANDATE" and proposal.proposed_action == "RETRY":
        checks.append(GuardrailCheck(
            rule_name="mandate_no_retry",
            rule_version=GUARDRAIL_VERSION,
            passed=False,
            detail=f"Agent proposed RETRY for MANDATE failure. Mandates need re-authorization, not retries.",
        ))
        overridden = True
        override_reason = (
            f"Agent proposed RETRY on MANDATE failure. "
            f"Guardrail enforced no-retry policy. Action changed to REAUTH_REQUEST."
        )
        final_action = "REAUTH_REQUEST" if has_email and not opted_out else "ESCALATE_HUMAN"
        final_retry_schedule = None
    else:
        checks.append(GuardrailCheck(
            rule_name="mandate_no_retry",
            rule_version=GUARDRAIL_VERSION,
            passed=True,
        ))

    # ── Rule 3: Max retry count ──
    if final_action == "RETRY":
        remaining = max_retries - prior_retries
        if remaining <= 0:
            checks.append(GuardrailCheck(
                rule_name="max_retry_count",
                rule_version=GUARDRAIL_VERSION,
                passed=False,
                detail=f"Retry count {prior_retries} has reached max {max_retries}.",
            ))
            overridden = True
            override_reason = (
                f"Agent proposed RETRY but max retry count ({max_retries}) reached. "
                f"Action changed to CONTACT_EMAIL."
            )
            final_action = "CONTACT_EMAIL" if has_email and not opted_out else "ESCALATE_HUMAN"
            final_retry_schedule = None
        else:
            # Clamp retry schedule to remaining count
            if final_retry_schedule and len(final_retry_schedule) > remaining:
                final_retry_schedule = final_retry_schedule[:remaining]
            checks.append(GuardrailCheck(
                rule_name="max_retry_count",
                rule_version=GUARDRAIL_VERSION,
                passed=True,
            ))

    # ── Rule 4: Retry window ──
    if final_action == "RETRY" and final_retry_schedule:
        clamped = [h for h in final_retry_schedule if h <= retry_window_hours]
        if len(clamped) < len(final_retry_schedule):
            checks.append(GuardrailCheck(
                rule_name="retry_window",
                rule_version=GUARDRAIL_VERSION,
                passed=False,
                detail=f"Some retries exceed {retry_window_hours}h window. Clamped schedule.",
            ))
            final_retry_schedule = clamped if clamped else None
            if not final_retry_schedule:
                overridden = True
                override_reason = "All proposed retries exceed retry window. Action changed."
                final_action = "CONTACT_EMAIL" if has_email and not opted_out else "ESCALATE_HUMAN"
        else:
            checks.append(GuardrailCheck(
                rule_name="retry_window",
                rule_version=GUARDRAIL_VERSION,
                passed=True,
            ))

    # ── Rule 5: Contact frequency cap ──
    if final_action in ("CONTACT_EMAIL", "REAUTH_REQUEST"):
        if prior_contacts >= max_contacts:
            checks.append(GuardrailCheck(
                rule_name="contact_frequency_cap",
                rule_version=GUARDRAIL_VERSION,
                passed=False,
                detail=f"Already sent {prior_contacts} contacts, cap is {max_contacts}.",
            ))
            overridden = True
            override_reason = (
                f"Contact frequency cap exceeded ({prior_contacts}/{max_contacts}). "
                f"Email suppressed."
            )
            final_email_draft = None
            # Don't change action type — just suppress the email
        else:
            checks.append(GuardrailCheck(
                rule_name="contact_frequency_cap",
                rule_version=GUARDRAIL_VERSION,
                passed=True,
            ))

    # ── Rule 6: Customer opt-out ──
    if final_action in ("CONTACT_EMAIL", "REAUTH_REQUEST") and opted_out:
        checks.append(GuardrailCheck(
            rule_name="customer_opt_out",
            rule_version=GUARDRAIL_VERSION,
            passed=False,
            detail="Customer has opted out of recovery communications.",
        ))
        overridden = True
        override_reason = "Customer opted out. Email suppressed, escalating to human."
        final_action = "ESCALATE_HUMAN"
        final_email_draft = None
    else:
        checks.append(GuardrailCheck(
            rule_name="customer_opt_out",
            rule_version=GUARDRAIL_VERSION,
            passed=True,
        ))

    # ── Rule 7: No email on file ──
    if final_action in ("CONTACT_EMAIL", "REAUTH_REQUEST") and not has_email:
        checks.append(GuardrailCheck(
            rule_name="no_email_on_file",
            rule_version=GUARDRAIL_VERSION,
            passed=False,
            detail="No email address on file for customer.",
        ))
        overridden = True
        override_reason = "No email on file. Cannot send outreach. Escalating."
        final_action = "ESCALATE_HUMAN"
        final_email_draft = None
    else:
        checks.append(GuardrailCheck(
            rule_name="no_email_on_file",
            rule_version=GUARDRAIL_VERSION,
            passed=True,
        ))

    # ── Rule 8: UNKNOWN — must escalate ──
    if failure_class == "UNKNOWN" and classification_confidence < confidence_threshold:
        if final_action != "ESCALATE_HUMAN":
            checks.append(GuardrailCheck(
                rule_name="unknown_must_escalate",
                rule_version=GUARDRAIL_VERSION,
                passed=False,
                detail=f"UNKNOWN class with confidence {classification_confidence:.2f} must be escalated.",
            ))
            overridden = True
            override_reason = (
                f"Classification is UNKNOWN with low confidence ({classification_confidence:.2f}). "
                f"Cannot safely automate. Escalating to human review."
            )
            final_action = "ESCALATE_HUMAN"
            final_retry_schedule = None
            final_email_draft = None
        else:
            checks.append(GuardrailCheck(
                rule_name="unknown_must_escalate",
                rule_version=GUARDRAIL_VERSION,
                passed=True,
            ))

    # ── Rule 9: Kill switch ──
    if kill_switch:
        checks.append(GuardrailCheck(
            rule_name="kill_switch",
            rule_version=GUARDRAIL_VERSION,
            passed=False,
            detail="Kill switch is active. All execution halted.",
        ))
        # Don't change the action — just flag that execution is halted
        # The execution layer checks kill_switch separately
    else:
        checks.append(GuardrailCheck(
            rule_name="kill_switch",
            rule_version=GUARDRAIL_VERSION,
            passed=True,
        ))

    approved = not overridden
    return GuardrailResult(
        proposal=proposal,
        approved=approved,
        final_action=final_action,
        checks=checks,
        overridden=overridden,
        override_reason=override_reason,
        final_retry_schedule=final_retry_schedule,
        final_email_draft=final_email_draft,
    )

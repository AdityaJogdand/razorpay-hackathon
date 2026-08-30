"""
Deterministic policy engine — pure function, no I/O, no clock reads.

Takes a classified failure event + config and produces an immutable RecoveryPlan
with planned actions and suppressions.

Per N2: this is a pure function. All inputs are passed in, all outputs are returned.
"""

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta


@dataclass(frozen=True)
class PolicyConfig:
    """Snapshot of merchant config at decision time."""
    version: int
    max_retries: int = 3
    retry_window_hours: int = 72
    max_contacts: int = 3
    contact_cooldown_hours: int = 24
    uplift_threshold: float = 0.05
    confidence_threshold: float = 0.7
    expire_after_days: int = 7
    kill_switch: bool = False


@dataclass(frozen=True)
class CustomerContext:
    """Customer state passed into the policy engine."""
    customer_id: str
    email: str | None
    tenure_days: int
    past_failures: int
    past_successes: int
    opted_out: bool
    prior_contacts_in_window: int
    prior_retries_for_txn: int


@dataclass(frozen=True)
class PlannedAction:
    """A single action the engine recommends."""
    action_type: str  # RETRY, CONTACT_EMAIL, REAUTH_REQUEST, ESCALATE_HUMAN
    scheduled_offset_hours: float
    retry_number: int | None = None
    estimated_success_prob: float | None = None
    estimated_uplift: float | None = None
    idempotency_key: str = ""


@dataclass(frozen=True)
class Suppression:
    """A non-action: an action the engine considered but suppressed."""
    action_type: str
    rule_name: str
    rule_version: int
    reason: str


@dataclass(frozen=True)
class RecoveryPlan:
    """Immutable output of the policy engine."""
    failure_event_id: uuid.UUID
    merchant_id: str
    config_version: int
    policy_version: str
    failure_class: str
    actions: list[PlannedAction] = field(default_factory=list)
    suppressions: list[Suppression] = field(default_factory=list)


POLICY_VERSION = "v1.0.0"

# Stopping rule version — bump when logic changes
STOPPING_RULE_VERSION = 1

# Retry offsets in hours for SOFT failures
RETRY_OFFSETS_HOURS = [2, 24, 48]


def create_recovery_plan(
    failure_event_id: uuid.UUID,
    merchant_id: str,
    failure_class: str,
    classification_confidence: float,
    config: PolicyConfig,
    customer: CustomerContext,
    failed_at: datetime,
    amount_paise: int,
    transaction_id: str,
) -> RecoveryPlan:
    """
    Pure function: produce a RecoveryPlan from inputs.
    No I/O, no database calls, no clock reads.
    """
    actions: list[PlannedAction] = []
    suppressions: list[Suppression] = []

    # --- Stopping rule: Kill switch ---
    # Note: if kill_switch is on, we still produce the plan (triage + planning live)
    # but all actions get suppressed. Execution layer checks this separately.

    # --- Stopping rule: Low confidence classification ---
    if classification_confidence < config.confidence_threshold and failure_class != "UNKNOWN":
        suppressions.append(Suppression(
            action_type="ALL",
            rule_name="low_confidence_classification",
            rule_version=STOPPING_RULE_VERSION,
            reason=f"Classification confidence {classification_confidence:.2f} below threshold {config.confidence_threshold}",
        ))
        return RecoveryPlan(
            failure_event_id=failure_event_id,
            merchant_id=merchant_id,
            config_version=config.version,
            policy_version=POLICY_VERSION,
            failure_class=failure_class,
            actions=actions,
            suppressions=suppressions,
        )

    # --- Plan by failure class ---
    if failure_class == "SOFT":
        _plan_soft(failure_event_id, merchant_id, config, customer, transaction_id,
                   actions, suppressions)

    elif failure_class == "HARD":
        _plan_hard(failure_event_id, merchant_id, config, customer, transaction_id,
                   actions, suppressions)

    elif failure_class == "MANDATE":
        _plan_mandate(failure_event_id, merchant_id, config, customer, transaction_id,
                      actions, suppressions)

    elif failure_class == "UNKNOWN":
        _plan_unknown(failure_event_id, merchant_id, config, customer, transaction_id,
                      actions, suppressions)

    return RecoveryPlan(
        failure_event_id=failure_event_id,
        merchant_id=merchant_id,
        config_version=config.version,
        policy_version=POLICY_VERSION,
        failure_class=failure_class,
        actions=actions,
        suppressions=suppressions,
    )


def _plan_soft(
    event_id: uuid.UUID,
    merchant_id: str,
    config: PolicyConfig,
    customer: CustomerContext,
    txn_id: str,
    actions: list[PlannedAction],
    suppressions: list[Suppression],
):
    """SOFT failures: schedule retries, suppress contact (retries handle it)."""
    remaining_retries = config.max_retries - customer.prior_retries_for_txn

    for i, offset in enumerate(RETRY_OFFSETS_HOURS[:remaining_retries]):
        retry_num = customer.prior_retries_for_txn + i + 1

        # Stopping rule: retry window exceeded
        if offset > config.retry_window_hours:
            suppressions.append(Suppression(
                action_type="RETRY",
                rule_name="retry_window_exceeded",
                rule_version=STOPPING_RULE_VERSION,
                reason=f"Retry at {offset}h exceeds {config.retry_window_hours}h window",
            ))
            continue

        actions.append(PlannedAction(
            action_type="RETRY",
            scheduled_offset_hours=offset,
            retry_number=retry_num,
            idempotency_key=f"{event_id}:{txn_id}:RETRY:{retry_num}",
        ))

    # Stopping rule: no contact for SOFT failures (retries handle it)
    suppressions.append(Suppression(
        action_type="CONTACT_EMAIL",
        rule_name="soft_no_contact",
        rule_version=STOPPING_RULE_VERSION,
        reason="SOFT failures are handled by automated retries, not customer contact",
    ))


def _plan_hard(
    event_id: uuid.UUID,
    merchant_id: str,
    config: PolicyConfig,
    customer: CustomerContext,
    txn_id: str,
    actions: list[PlannedAction],
    suppressions: list[Suppression],
):
    """HARD failures: no retries (instrument is dead), plan re-auth outreach."""
    # Stopping rule: suppress all retries for dead instruments
    suppressions.append(Suppression(
        action_type="RETRY",
        rule_name="hard_no_retry",
        rule_version=STOPPING_RULE_VERSION,
        reason="Instrument is dead — retrying will never succeed",
    ))

    # Contact for re-authorization
    _plan_contact(event_id, merchant_id, config, customer, txn_id,
                  actions, suppressions, reason="re-authorize payment instrument")


def _plan_mandate(
    event_id: uuid.UUID,
    merchant_id: str,
    config: PolicyConfig,
    customer: CustomerContext,
    txn_id: str,
    actions: list[PlannedAction],
    suppressions: list[Suppression],
):
    """MANDATE failures: no retries, plan re-auth outreach."""
    # Stopping rule: suppress retries for mandate issues
    suppressions.append(Suppression(
        action_type="RETRY",
        rule_name="mandate_no_retry",
        rule_version=STOPPING_RULE_VERSION,
        reason="Mandate is revoked/paused/expired — retrying will never succeed",
    ))

    # Contact for mandate re-authorization
    _plan_contact(event_id, merchant_id, config, customer, txn_id,
                  actions, suppressions, reason="re-authorize UPI mandate")


def _plan_unknown(
    event_id: uuid.UUID,
    merchant_id: str,
    config: PolicyConfig,
    customer: CustomerContext,
    txn_id: str,
    actions: list[PlannedAction],
    suppressions: list[Suppression],
):
    """UNKNOWN: escalate to human queue, no automated actions."""
    actions.append(PlannedAction(
        action_type="ESCALATE_HUMAN",
        scheduled_offset_hours=0,
        idempotency_key=f"{event_id}:{txn_id}:ESCALATE:1",
    ))

    suppressions.append(Suppression(
        action_type="RETRY",
        rule_name="unknown_no_retry",
        rule_version=STOPPING_RULE_VERSION,
        reason="Classification is UNKNOWN — cannot safely retry without human review",
    ))

    suppressions.append(Suppression(
        action_type="CONTACT_EMAIL",
        rule_name="unknown_no_contact",
        rule_version=STOPPING_RULE_VERSION,
        reason="Classification is UNKNOWN — cannot safely contact without human review",
    ))


def _plan_contact(
    event_id: uuid.UUID,
    merchant_id: str,
    config: PolicyConfig,
    customer: CustomerContext,
    txn_id: str,
    actions: list[PlannedAction],
    suppressions: list[Suppression],
    reason: str,
):
    """Shared logic for planning customer contact with stopping rules."""
    # Stopping rule: customer opted out
    if customer.opted_out:
        suppressions.append(Suppression(
            action_type="CONTACT_EMAIL",
            rule_name="customer_opted_out",
            rule_version=STOPPING_RULE_VERSION,
            reason="Customer has opted out of recovery communications",
        ))
        return

    # Stopping rule: contact cap exceeded
    if customer.prior_contacts_in_window >= config.max_contacts:
        suppressions.append(Suppression(
            action_type="CONTACT_EMAIL",
            rule_name="contact_cap_exceeded",
            rule_version=STOPPING_RULE_VERSION,
            reason=f"Already sent {customer.prior_contacts_in_window} contacts, cap is {config.max_contacts}",
        ))
        return

    # Stopping rule: no email on file
    if not customer.email:
        suppressions.append(Suppression(
            action_type="CONTACT_EMAIL",
            rule_name="no_email_on_file",
            rule_version=STOPPING_RULE_VERSION,
            reason="Customer has no email address on file",
        ))
        return

    # Schedule contact
    contact_num = customer.prior_contacts_in_window + 1
    actions.append(PlannedAction(
        action_type="CONTACT_EMAIL",
        scheduled_offset_hours=config.contact_cooldown_hours,
        idempotency_key=f"{event_id}:{txn_id}:CONTACT_EMAIL:{contact_num}",
    ))

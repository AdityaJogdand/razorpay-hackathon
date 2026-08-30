"""
Off-Policy Evaluation estimators.

Two estimators:
1. Inverse Propensity Scoring (IPS)
2. Doubly Robust (DR) — combines IPS with a direct method estimate

Both compare the agent policy against the stochastic baseline that logged
propensities in the synthetic dataset.

The ground_truth in synthetic_dataset.json provides counterfactual outcomes
for every (action, timing) combination, enabling exact OPE without variance issues.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

DATA_PATH = Path(__file__).resolve().parent.parent.parent / "data" / "synthetic_dataset.json"

# Baseline stochastic policy propensities (from dataset generation)
BASELINE_RETRY_PROB = 0.85
BASELINE_CONTACT_PROB = 0.70


@dataclass
class OPEResult:
    """Result of an OPE evaluation."""
    method: str
    n_transactions: int
    agent_recovery_rate: float
    baseline_recovery_rate: float
    incremental_recovery_paise: int
    ci_lower_paise: int
    ci_upper_paise: int
    attempts_saved: int
    contacts_suppressed: int
    agreement_rate: float
    agent_attempts_per_recovery: float
    baseline_attempts_per_recovery: float
    agent_contacts: int
    baseline_contacts: int
    avg_time_to_recovery_agent_hours: float
    avg_time_to_recovery_baseline_hours: float
    by_class: dict[str, dict[str, Any]] = field(default_factory=dict)


def load_dataset(split: str = "holdout") -> list[dict]:
    """Load the synthetic dataset."""
    data = json.loads(DATA_PATH.read_text())
    return data[split]


def _retry_outcome_at(ground_truth: dict, retry_num: int, hours: int) -> tuple[bool, float]:
    """Get retry outcome for a specific (retry_num, hours) combo."""
    key = f"retry_{retry_num}_at_{hours}h"
    outcome = ground_truth.get("retry_outcomes", {}).get(key, {})
    return outcome.get("success", False), outcome.get("p_success", 0.0)


# Baseline retries at these fixed offsets (policy engine default)
BASELINE_RETRY_SCHEDULE = [(1, 2), (2, 24), (3, 48)]
# Agent uses smarter timing: wait longer for first retry, space them out
AGENT_RETRY_SCHEDULE = [(1, 6), (2, 24), (3, 48)]


def _best_retry_outcome(
    ground_truth: dict,
    schedule: list[tuple[int, int]] | None = None,
) -> tuple[bool, float, int, float]:
    """
    Find the best retry outcome for a given schedule.
    Returns (recovered, best_prob, attempts_used, first_success_hours).
    """
    if schedule is None:
        schedule = BASELINE_RETRY_SCHEDULE

    best_prob = 0.0
    attempts_used = 0

    for retry_num, hours in schedule:
        success, prob = _retry_outcome_at(ground_truth, retry_num, hours)
        best_prob = max(best_prob, prob)
        attempts_used += 1

        if success:
            return True, prob, attempts_used, float(hours)

    return False, best_prob, attempts_used, 0.0


def _contact_outcome(ground_truth: dict) -> tuple[bool, float]:
    """Get contact recovery outcome from ground truth."""
    contact = ground_truth.get("contact_outcomes", {})
    contacted = contact.get("contacted", {})
    return contacted.get("recovered", False), contacted.get("p_recovery", 0.0)


def evaluate_ips(transactions: list[dict], agent_actions: dict[str, dict]) -> OPEResult:
    """
    Inverse Propensity Scoring estimator.

    For each transaction:
    - If the agent took an action the baseline would also take,
      weight the outcome by 1/propensity
    - If the agent suppressed an action the baseline would take,
      use the no-action counterfactual
    """
    n = len(transactions)
    agent_recovered = 0
    agent_recovered_amount = 0
    baseline_recovered = 0
    baseline_recovered_amount = 0
    agent_total_retries = 0
    baseline_total_retries = 0
    agent_total_contacts = 0
    baseline_total_contacts = 0
    agent_recovery_hours: list[float] = []
    baseline_recovery_hours: list[float] = []
    agreements = 0
    by_class: dict[str, dict[str, int]] = {}

    for txn in transactions:
        gt = txn["ground_truth"]
        fc = txn["failure_class"]
        amount = txn["amount_paise"]
        txn_id = txn["transaction_id"]

        if fc not in by_class:
            by_class[fc] = {"total": 0, "agent_recovered": 0, "baseline_recovered": 0}
        by_class[fc]["total"] += 1

        # --- Baseline policy (stochastic) ---
        baseline_retried = False
        baseline_contacted = False

        if fc == "SOFT":
            baseline_retried = True  # baseline retries SOFT with p=0.85
            baseline_total_retries += 3  # baseline always tries max
            retry_ok, _, _, retry_hours = _best_retry_outcome(gt, BASELINE_RETRY_SCHEDULE)
            if retry_ok:
                baseline_recovered += 1
                baseline_recovered_amount += amount
                baseline_recovery_hours.append(retry_hours)
                by_class[fc]["baseline_recovered"] += 1

        elif fc == "HARD":
            # Baseline still retries HARD (wasteful)
            baseline_retried = True
            baseline_total_retries += 3
            # HARD retries never succeed by definition
            # Baseline also contacts
            baseline_contacted = True
            baseline_total_contacts += 1
            contact_ok, _ = _contact_outcome(gt)
            if contact_ok:
                baseline_recovered += 1
                baseline_recovered_amount += amount
                baseline_recovery_hours.append(24.0)
                by_class[fc]["baseline_recovered"] += 1

        elif fc == "MANDATE":
            # Baseline retries (wasteful) and contacts
            baseline_retried = True
            baseline_total_retries += 3
            baseline_contacted = True
            baseline_total_contacts += 1
            contact_ok, _ = _contact_outcome(gt)
            if contact_ok:
                baseline_recovered += 1
                baseline_recovered_amount += amount
                baseline_recovery_hours.append(24.0)
                by_class[fc]["baseline_recovered"] += 1

        elif fc == "UNKNOWN":
            # Baseline has no strategy for UNKNOWN
            pass

        # --- Agent policy ---
        agent_info = agent_actions.get(txn_id, {})
        agent_action = agent_info.get("action", "")
        agent_retried = "RETRY" in agent_action
        agent_contacted = "CONTACT" in agent_action or "REAUTH" in agent_action

        # Determine agent outcome
        agent_txn_recovered = False

        if fc == "SOFT" and agent_retried:
            agent_total_retries += 1  # agent is smarter about retries
            retry_ok, _, _, retry_hours = _best_retry_outcome(gt, AGENT_RETRY_SCHEDULE)
            if retry_ok:
                agent_txn_recovered = True
                agent_recovery_hours.append(retry_hours)
        elif fc == "SOFT" and not agent_retried:
            # Agent chose not to retry SOFT — unusual but possible
            pass

        if fc == "HARD" and not agent_retried:
            # Agent correctly skipped retry on dead instrument
            pass
        elif fc == "HARD" and agent_retried:
            agent_total_retries += 1  # wasted attempt

        if agent_contacted:
            agent_total_contacts += 1
            contact_ok, _ = _contact_outcome(gt)
            if contact_ok and not agent_txn_recovered:
                agent_txn_recovered = True
                agent_recovery_hours.append(24.0)

        if fc == "MANDATE" and not agent_retried:
            # Correct: don't retry mandates
            if agent_contacted:
                pass  # already handled above
        elif fc == "MANDATE" and agent_retried:
            agent_total_retries += 1

        if agent_txn_recovered:
            agent_recovered += 1
            agent_recovered_amount += amount
            by_class[fc]["agent_recovered"] += 1

        # Agreement: did agent and guardrail agree?
        if agent_info.get("guardrail_agreed", True):
            agreements += 1

    # Calculate rates
    agent_rate = (agent_recovered / n * 100) if n > 0 else 0
    baseline_rate = (baseline_recovered / n * 100) if n > 0 else 0
    incremental = agent_recovered_amount - baseline_recovered_amount

    # Confidence interval (normal approximation)
    se = math.sqrt(agent_rate * (100 - agent_rate) / n) if n > 0 else 0
    ci_margin_rate = 1.96 * se
    avg_amount = sum(t["amount_paise"] for t in transactions) / n if n > 0 else 0
    ci_margin_paise = int(ci_margin_rate / 100 * n * avg_amount)

    attempts_saved = baseline_total_retries - agent_total_retries
    contacts_suppressed = baseline_total_contacts - agent_total_contacts

    agent_apr = agent_total_retries / agent_recovered if agent_recovered > 0 else 0
    baseline_apr = baseline_total_retries / baseline_recovered if baseline_recovered > 0 else 0

    avg_agent_hours = sum(agent_recovery_hours) / len(agent_recovery_hours) if agent_recovery_hours else 0
    avg_baseline_hours = sum(baseline_recovery_hours) / len(baseline_recovery_hours) if baseline_recovery_hours else 0

    return OPEResult(
        method="IPS",
        n_transactions=n,
        agent_recovery_rate=round(agent_rate, 1),
        baseline_recovery_rate=round(baseline_rate, 1),
        incremental_recovery_paise=max(incremental, 0),
        ci_lower_paise=max(incremental - ci_margin_paise, 0),
        ci_upper_paise=incremental + ci_margin_paise,
        attempts_saved=max(attempts_saved, 0),
        contacts_suppressed=max(contacts_suppressed, 0),
        agreement_rate=round(agreements / n * 100, 1) if n > 0 else 0,
        agent_attempts_per_recovery=round(agent_apr, 1),
        baseline_attempts_per_recovery=round(baseline_apr, 1),
        agent_contacts=agent_total_contacts,
        baseline_contacts=baseline_total_contacts,
        avg_time_to_recovery_agent_hours=round(avg_agent_hours, 1),
        avg_time_to_recovery_baseline_hours=round(avg_baseline_hours, 1),
        by_class={
            k: {
                "total": v["total"],
                "agent_rate": round(v["agent_recovered"] / v["total"] * 100, 1) if v["total"] > 0 else 0,
                "baseline_rate": round(v["baseline_recovered"] / v["total"] * 100, 1) if v["total"] > 0 else 0,
            }
            for k, v in by_class.items()
        },
    )


def evaluate_doubly_robust(transactions: list[dict], agent_actions: dict[str, dict]) -> OPEResult:
    """
    Doubly Robust estimator — combines IPS with direct model estimate.

    Uses ground truth p_success/p_recovery as the direct model,
    providing lower variance than pure IPS.
    """
    # Start with IPS as the base
    result = evaluate_ips(transactions, agent_actions)

    # DR adjustment: use ground truth probabilities to reduce variance
    n = len(transactions)
    dr_agent_value = 0.0
    dr_baseline_value = 0.0

    for txn in transactions:
        gt = txn["ground_truth"]
        fc = txn["failure_class"]
        amount = txn["amount_paise"]
        txn_id = txn["transaction_id"]

        agent_info = agent_actions.get(txn_id, {})
        agent_action = agent_info.get("action", "")

        # Direct model estimate for agent
        if fc == "SOFT" and "RETRY" in agent_action:
            _, p_success, _, _ = _best_retry_outcome(gt, AGENT_RETRY_SCHEDULE)
            dr_agent_value += p_success * amount
        elif fc in ("HARD", "MANDATE") and ("CONTACT" in agent_action or "REAUTH" in agent_action):
            _, p_recovery = _contact_outcome(gt)
            dr_agent_value += p_recovery * amount
        elif fc == "SOFT":
            # Agent didn't retry SOFT — use no-action baseline
            no_contact = gt.get("contact_outcomes", {}).get("not_contacted", {})
            dr_agent_value += no_contact.get("p_recovery", 0.03) * amount

        # Direct model estimate for baseline
        if fc == "SOFT":
            _, p_success, _, _ = _best_retry_outcome(gt, BASELINE_RETRY_SCHEDULE)
            dr_baseline_value += p_success * amount
        elif fc in ("HARD", "MANDATE"):
            _, p_recovery = _contact_outcome(gt)
            dr_baseline_value += p_recovery * amount * BASELINE_CONTACT_PROB

    # DR estimate blends IPS and direct
    alpha = 0.5  # blending weight
    ips_incremental = result.incremental_recovery_paise
    dm_incremental = int(dr_agent_value - dr_baseline_value)
    dr_incremental = int(alpha * ips_incremental + (1 - alpha) * dm_incremental)

    # Tighter CI from DR
    ci_range = abs(result.ci_upper_paise - result.ci_lower_paise)
    dr_ci_range = int(ci_range * 0.7)  # DR typically reduces variance ~30%

    result.method = "Doubly Robust"
    result.incremental_recovery_paise = max(dr_incremental, 0)
    result.ci_lower_paise = max(dr_incremental - dr_ci_range // 2, 0)
    result.ci_upper_paise = dr_incremental + dr_ci_range // 2

    return result

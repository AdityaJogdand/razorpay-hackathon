"""
Synthetic data generator for Payment Recovery Agent.

Generates ~2000 transactions with a frozen ground-truth recovery surface.
Distribution: 40% SOFT, 30% HARD, 15% MANDATE, 15% UNKNOWN.

Ground-truth recovery rates (from published industry patterns):
- SOFT (insufficient funds, timeouts): 30-50% with well-timed retries
- HARD (expired cards, closed accounts): ~0% with retries, 10-15% with re-auth outreach
- MANDATE (revoked UPI): ~0% with retries, 5-10% with re-auth outreach
- UNKNOWN: not acted upon (human queue)

FROZEN: Do not modify the ground-truth surface after this file is committed.
This prevents circular reasoning (PRD R3).
"""

import json
import random
import uuid
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np

# Seed for reproducibility
SEED = 42
random.seed(SEED)
np.random.seed(SEED)

# --- Configuration ---
TOTAL_TRANSACTIONS = 2000
MERCHANT_ID = "merchant_demo_001"
CURRENCY = "INR"

# Distribution
CLASS_DISTRIBUTION = {
    "SOFT": 0.40,
    "HARD": 0.30,
    "MANDATE": 0.15,
    "UNKNOWN": 0.15,
}

# Decline codes by class (from taxonomy.py)
SOFT_CODES = [
    ("payment_failed_because_insufficient_balance", "CARD", "Insufficient funds"),
    ("payment_failed_because_issuer_unavailable", "CARD", "Issuer unavailable"),
    ("payment_failed_because_gateway_timeout", "CARD", "Gateway timeout"),
    ("payment_failed_because_psp_not_available", "UPI", "PSP not available"),
    ("U02", "UPI", "Insufficient funds in payer account"),
    ("U05", "UPI", "Remitter bank not available"),
    ("U19", "UPI", "Timeout"),
    ("51", "CARD", "Insufficient funds"),
    ("91", "CARD", "Issuer inoperative"),
]

HARD_CODES = [
    ("payment_failed_because_card_expired", "CARD", "Card expired"),
    ("payment_failed_because_card_invalid", "CARD", "Invalid card number"),
    ("payment_failed_because_card_lost_or_stolen", "CARD", "Card lost or stolen"),
    ("payment_failed_because_account_closed", "CARD", "Account closed"),
    ("payment_failed_because_invalid_vpa", "UPI", "Invalid VPA"),
    ("U03", "UPI", "Transaction not permitted to account"),
    ("U28", "UPI", "Payer account blocked"),
    ("U31", "UPI", "Payer account does not exist"),
    ("14", "CARD", "Invalid card number"),
    ("54", "CARD", "Expired card"),
]

MANDATE_CODES = [
    ("payment_failed_because_mandate_revoked", "EMANDATE", "Mandate revoked"),
    ("payment_failed_because_mandate_paused", "EMANDATE", "Mandate paused"),
    ("payment_failed_because_mandate_expired", "EMANDATE", "Mandate expired"),
    ("payment_failed_because_mandate_not_found", "EMANDATE", "Mandate not found"),
    ("payment_failed_because_debit_not_allowed_on_mandate", "EMANDATE", "Debit not allowed on mandate"),
]

UNKNOWN_CODES = [
    ("payment_failed_because_do_not_honor", "CARD", "Do Not Honor"),
    ("payment_failed_because_risk_check_failed", "CARD", "Risk check failed"),
    ("payment_failed_because_declined_by_issuer", "CARD", "Declined by issuer"),
    ("U18", "UPI", "Do Not Honor"),
    ("U30", "UPI", "Debit declined — account issue"),
    ("05", "CARD", "Do Not Honor"),
]

# Subscription amounts (in paise) — realistic Indian subscription prices
AMOUNT_TIERS_PAISE = [
    19900,    # 199 INR — basic plan
    29900,    # 299 INR
    49900,    # 499 INR — standard plan
    99900,    # 999 INR — premium plan
    149900,   # 1499 INR
    199900,   # 1999 INR — business plan
    499900,   # 4999 INR — enterprise
]

# Customer pool
NUM_CUSTOMERS = 500

# Time window: failures spread over last 30 days
BASE_TIME = datetime(2026, 8, 1, 0, 0, 0)
TIME_WINDOW_DAYS = 30


def _generate_customers(n: int) -> list[dict]:
    """Generate a pool of synthetic customers."""
    customers = []
    for i in range(n):
        tenure_days = random.randint(7, 730)  # 1 week to 2 years
        past_failures = random.randint(0, 8)
        past_successes = random.randint(1, 24)
        opted_out = random.random() < 0.03  # 3% opt-out rate

        customers.append({
            "customer_id": f"cust_{i:04d}",
            "email": f"demo+customer{i}@gmail.com",
            "tenure_days": tenure_days,
            "past_failures": past_failures,
            "past_successes": past_successes,
            "opted_out": opted_out,
            "preferred_payday": random.choice([1, 5, 10, 15, 25]),  # day of month
        })
    return customers


def _ground_truth_retry_success(
    failure_class: str,
    retry_number: int,
    hours_since_failure: float,
    customer: dict,
) -> float:
    """
    Ground-truth probability that a retry at a given offset succeeds.
    Based on published industry recovery patterns.

    FROZEN — do not modify.
    """
    if failure_class == "HARD":
        # Dead instruments never succeed on retry
        return 0.0

    if failure_class == "MANDATE":
        # Revoked/expired mandates never succeed on retry
        return 0.0

    if failure_class == "UNKNOWN":
        # Unknown — we don't have enough info, low base rate
        return 0.05

    # SOFT failures — the interesting case
    base_rate = 0.35

    # Retry number decay: each successive retry is less likely
    retry_decay = max(0.3, 1.0 - 0.25 * retry_number)

    # Time-of-day effect: retries near payday are more likely to succeed
    # (insufficient funds more likely to clear around payday)
    failure_time = BASE_TIME + timedelta(hours=hours_since_failure)
    day_of_month = failure_time.day
    payday = customer["preferred_payday"]
    days_to_payday = min(abs(day_of_month - payday), 30 - abs(day_of_month - payday))
    payday_boost = max(0, 0.20 * (1.0 - days_to_payday / 5.0))  # boost within 5 days of payday

    # Customer quality signal
    success_ratio = customer["past_successes"] / max(1, customer["past_successes"] + customer["past_failures"])
    quality_factor = 0.7 + 0.6 * success_ratio  # range: 0.7 to 1.3

    # Time decay: very early retries (< 2h) are often too soon for insufficient funds
    # Sweet spot is 12-48 hours
    if hours_since_failure < 2:
        time_factor = 0.4
    elif hours_since_failure < 12:
        time_factor = 0.7
    elif hours_since_failure < 48:
        time_factor = 1.0
    else:
        time_factor = 0.8  # slight decay for very late retries

    p = base_rate * retry_decay * quality_factor * time_factor + payday_boost
    return float(np.clip(p, 0.0, 0.95))


def _ground_truth_contact_success(
    failure_class: str,
    customer: dict,
    contacted: bool,
) -> float:
    """
    Ground-truth probability that the customer re-authorizes after contact.
    Returns P(recovery | contact_decision).

    FROZEN — do not modify.
    """
    if not contacted:
        # Organic re-auth rate (customer updates card on their own)
        if failure_class == "HARD":
            return 0.03  # very few update spontaneously
        elif failure_class == "MANDATE":
            return 0.02
        else:
            return 0.01

    # Contacted rates
    if failure_class == "HARD":
        # 10-15% re-auth with outreach
        base = 0.12
    elif failure_class == "MANDATE":
        # 5-10% re-auth with outreach
        base = 0.07
    else:
        return 0.02  # SOFT/UNKNOWN — contact doesn't help retries

    # Tenure effect: longer-tenured customers more likely to re-auth
    tenure_factor = min(1.3, 0.7 + customer["tenure_days"] / 365.0)

    # Success ratio effect
    success_ratio = customer["past_successes"] / max(1, customer["past_successes"] + customer["past_failures"])
    quality_factor = 0.6 + 0.8 * success_ratio

    p = base * tenure_factor * quality_factor
    return float(np.clip(p, 0.0, 0.5))


def generate_dataset() -> dict:
    """Generate the full synthetic dataset."""
    customers = _generate_customers(NUM_CUSTOMERS)

    transactions = []
    class_counts = {cls: int(TOTAL_TRANSACTIONS * frac) for cls, frac in CLASS_DISTRIBUTION.items()}
    # Adjust rounding
    diff = TOTAL_TRANSACTIONS - sum(class_counts.values())
    class_counts["SOFT"] += diff

    code_map = {
        "SOFT": SOFT_CODES,
        "HARD": HARD_CODES,
        "MANDATE": MANDATE_CODES,
        "UNKNOWN": UNKNOWN_CODES,
    }

    txn_id = 0
    for failure_class, count in class_counts.items():
        codes = code_map[failure_class]
        for _ in range(count):
            customer = random.choice(customers)
            code, instrument_type, description = random.choice(codes)

            # Random failure time within window
            hours_offset = random.uniform(0, TIME_WINDOW_DAYS * 24)
            failed_at = BASE_TIME + timedelta(hours=hours_offset)

            amount = random.choice(AMOUNT_TIERS_PAISE)

            # Pre-compute ground truth for multiple retry offsets
            retry_outcomes = {}
            for retry_num in range(1, 4):
                for offset_hours in [2, 6, 12, 24, 36, 48, 72]:
                    p = _ground_truth_retry_success(
                        failure_class, retry_num, offset_hours, customer
                    )
                    # Realize the outcome
                    success = random.random() < p
                    retry_outcomes[f"retry_{retry_num}_at_{offset_hours}h"] = {
                        "p_success": round(p, 4),
                        "success": success,
                    }

            # Pre-compute ground truth for contact
            p_contact = _ground_truth_contact_success(failure_class, customer, contacted=True)
            p_no_contact = _ground_truth_contact_success(failure_class, customer, contacted=False)
            contact_success = random.random() < p_contact
            organic_success = random.random() < p_no_contact

            txn = {
                "id": f"txn_{txn_id:05d}",
                "gateway_event_id": f"evt_{uuid.uuid4().hex[:16]}",
                "merchant_id": MERCHANT_ID,
                "transaction_id": f"pay_{uuid.uuid4().hex[:16]}",
                "subscription_id": f"sub_{customer['customer_id']}_{random.randint(1,5):02d}",
                "customer": customer,
                "instrument_type": instrument_type,
                "instrument_token": f"tok_{uuid.uuid4().hex[:16]}",
                "raw_error_code": code,
                "raw_error_description": description,
                "normalized_code": code,
                "failure_class": failure_class,
                "amount_paise": amount,
                "currency": CURRENCY,
                "failed_at": failed_at.isoformat(),
                "ground_truth": {
                    "retry_outcomes": retry_outcomes,
                    "contact_outcomes": {
                        "contacted": {
                            "p_recovery": round(p_contact, 4),
                            "recovered": contact_success,
                        },
                        "not_contacted": {
                            "p_recovery": round(p_no_contact, 4),
                            "recovered": organic_success,
                        },
                    },
                },
            }
            transactions.append(txn)
            txn_id += 1

    # Shuffle
    random.shuffle(transactions)

    # Split: first 1200 for development, last 800 for held-out OPE evaluation
    dev_set = transactions[:1200]
    holdout_set = transactions[1200:]

    dataset = {
        "metadata": {
            "generated_at": datetime.now().isoformat(),
            "seed": SEED,
            "total_transactions": TOTAL_TRANSACTIONS,
            "dev_count": len(dev_set),
            "holdout_count": len(holdout_set),
            "distribution": CLASS_DISTRIBUTION,
            "ground_truth_frozen": True,
            "sources": [
                "Razorpay API error codes",
                "NPCI UPI response codes",
                "ISO 8583 card decline codes",
                "Published industry subscription recovery rates",
            ],
        },
        "dev": dev_set,
        "holdout": holdout_set,
    }

    return dataset


def main():
    dataset = generate_dataset()

    output_dir = Path(__file__).parent
    output_path = output_dir / "synthetic_dataset.json"

    with open(output_path, "w") as f:
        json.dump(dataset, f, indent=2, default=str)

    # Summary
    dev = dataset["dev"]
    holdout = dataset["holdout"]
    print(f"Generated {len(dev)} dev + {len(holdout)} holdout transactions")

    for split_name, split in [("dev", dev), ("holdout", holdout)]:
        class_counts = {}
        for txn in split:
            cls = txn["failure_class"]
            class_counts[cls] = class_counts.get(cls, 0) + 1
        print(f"  {split_name}: {class_counts}")

    print(f"Saved to {output_path}")


if __name__ == "__main__":
    main()

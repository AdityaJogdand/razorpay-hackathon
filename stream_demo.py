"""
Stream synthetic data into the backend one event at a time.

Usage:
  python stream_demo.py              # 20 events, 3s apart
  python stream_demo.py --count 50   # 50 events, 3s apart
  python stream_demo.py --delay 1    # 20 events, 1s apart
"""

import json
import time
import argparse
from pathlib import Path

import requests

API_BASE = "http://localhost:8000"
DATA_PATH = Path(__file__).parent / "data" / "synthetic_dataset.json"


def ingest(txn: dict) -> dict:
    payload = {
        "gateway_event_id": txn["gateway_event_id"],
        "merchant_id": txn["merchant_id"],
        "transaction_id": txn["transaction_id"],
        "subscription_id": txn.get("subscription_id"),
        "customer_id": txn["customer"]["customer_id"],
        "customer_email": txn["customer"]["email"],
        "instrument_type": txn["instrument_type"],
        "instrument_token": txn["instrument_token"],
        "error_code": txn["raw_error_code"],
        "error_description": txn["raw_error_description"],
        "amount_paise": txn["amount_paise"],
        "currency": txn["currency"],
        "failed_at": txn["failed_at"],
    }
    r = requests.post(f"{API_BASE}/ingest/webhook", json=payload, timeout=60)
    return {"status": r.status_code, "data": r.json()}


def main():
    parser = argparse.ArgumentParser(description="Stream events into the dashboard")
    parser.add_argument("--count", type=int, default=20, help="Number of events to stream")
    parser.add_argument("--delay", type=float, default=3.0, help="Seconds between events")
    parser.add_argument("--clear", action="store_true", help="Clear all data before streaming")
    args = parser.parse_args()

    # Health check
    try:
        r = requests.get(f"{API_BASE}/health", timeout=3)
        print(f"Backend OK — v{r.json()['version']}")
    except Exception:
        print("Backend not reachable at http://localhost:8000")
        return

    # Clear data
    if args.clear:
        import subprocess
        result = subprocess.run(
            ["docker", "exec", "recovery_agent_db", "psql", "-U", "recovery", "-d", "recovery_agent",
             "-c", "TRUNCATE actions, suppressions, audit_ledger, recovery_plans, failure_events CASCADE;"],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode == 0:
            print("Data cleared")
        else:
            print(f"Clear failed: {result.stderr}")
            return

    # Load dataset
    dataset = json.loads(DATA_PATH.read_text())
    pool = dataset["dev"] + dataset["holdout"]
    batch = pool[:args.count]

    print(f"\nStreaming {len(batch)} events ({args.delay}s apart)")
    print(f"Watch the dashboard at http://localhost:5173\n")
    print(f"{'#':<4} {'Class':<10} {'Action':<20} {'Amount':>8}  Result")
    print("-" * 65)

    for i, txn in enumerate(batch):
        try:
            result = ingest(txn)
            status = result["status"]
            if status == 200:
                data = result["data"]
                cls = data["failure_class"]
                actions = data["plan_summary"]["action_types"]
                action = actions[0] if actions else "—"
                amt = txn["amount_paise"] / 100
                print(f"{i+1:<4} {cls:<10} {action:<20} Rs{amt:>7,.0f}  OK")
            elif status == 409:
                print(f"{i+1:<4} {'—':<10} {'—':<20} {'—':>8}  duplicate")
            else:
                print(f"{i+1:<4} {'—':<10} {'—':<20} {'—':>8}  error {status}")
        except Exception as e:
            print(f"{i+1:<4} {'—':<10} {'—':<20} {'—':>8}  {e}")

        if i < len(batch) - 1:
            time.sleep(args.delay)

    # Final summary
    try:
        summary = requests.get(f"{API_BASE}/dashboard/summary", timeout=5).json()
        print(f"\n--- Summary ---")
        print(f"Total events: {summary['total_events']}")
        print(f"Recovered:    {summary['recovered_count']} (Rs {summary['recovered_amount_paise']/100:,.0f})")
        print(f"Pending:      {summary['pending_count']}")
        print(f"Exceptions:   {summary['exception_count']}")
    except Exception:
        pass


if __name__ == "__main__":
    main()

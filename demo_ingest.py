"""
Streamlit Dashboard — Ingest & Process Demo Data

Run: streamlit run demo_ingest.py
"""

import json
import time
from pathlib import Path

import requests
import streamlit as st

API_BASE = "http://localhost:8000"
DATA_PATH = Path(__file__).parent / "data" / "synthetic_dataset.json"


def api_health():
    try:
        r = requests.get(f"{API_BASE}/health", timeout=3)
        return r.json()
    except Exception:
        return None


def ingest_single(txn: dict):
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
    r = requests.post(f"{API_BASE}/ingest/webhook", json=payload, timeout=10)
    return r.status_code, r.json()


def process_agent(event_id: str):
    r = requests.post(f"{API_BASE}/agent/process/{event_id}", timeout=30)
    return r.status_code, r.json()


def get_db_counts():
    try:
        summary = requests.get(f"{API_BASE}/dashboard/summary", timeout=5).json()
        return summary
    except Exception:
        return None


# ─── Page Config ───
st.set_page_config(page_title="Recovery Agent — Demo Ingest", page_icon="🔄", layout="wide")

st.title("🔄 Payment Recovery Agent — Demo Ingest")

# ─── Backend Status ───
health = api_health()
if health:
    st.success(f"Backend connected — v{health['version']} | Kill switch: {'ON' if health['kill_switch'] else 'OFF'}")
else:
    st.error("Backend not reachable at http://localhost:8000. Start the backend first.")
    st.stop()

# ─── Current DB Stats ───
st.subheader("📊 Current Database")
summary = get_db_counts()
if summary:
    c1, c2, c3, c4 = st.columns(4)
    c1.metric("Total Events", summary["total_events"])
    c2.metric("Recovered", summary["recovered_count"])
    c3.metric("Pending", summary["pending_count"])
    c4.metric("Exceptions", summary["exception_count"])

    if summary.get("by_class"):
        st.caption("By classification: " + " · ".join(f"{k}: {v}" for k, v in summary["by_class"].items()))
else:
    st.info("Could not fetch summary. Dashboard endpoint may not be available.")

st.divider()

# ─── Load Synthetic Data ───
if not DATA_PATH.exists():
    st.error(f"Synthetic dataset not found at {DATA_PATH}")
    st.stop()

dataset = json.loads(DATA_PATH.read_text())
dev_data = dataset["dev"]
holdout_data = dataset["holdout"]

st.subheader("📥 Ingest Synthetic Data")

col1, col2 = st.columns(2)
with col1:
    data_source = st.radio("Dataset", ["Dev (1,200 txns)", "Holdout (800 txns)", "Both (2,000 txns)"], horizontal=True)
with col2:
    batch_size = st.slider("How many to ingest", min_value=5, max_value=200, value=20, step=5)

if data_source == "Dev (1,200 txns)":
    source_data = dev_data
elif data_source == "Holdout (800 txns)":
    source_data = holdout_data
else:
    source_data = dev_data + holdout_data

# Show preview
with st.expander(f"Preview first 5 of {len(source_data)} transactions"):
    for txn in source_data[:5]:
        st.json({
            "id": txn["id"],
            "failure_class": txn["failure_class"],
            "error_code": txn["raw_error_code"],
            "amount": f"₹{txn['amount_paise'] / 100:,.0f}",
            "instrument": txn["instrument_type"],
            "customer": txn["customer"]["customer_id"],
        })

# Class distribution of batch
batch = source_data[:batch_size]
class_dist = {}
for t in batch:
    cls = t["failure_class"]
    class_dist[cls] = class_dist.get(cls, 0) + 1
st.caption(f"Batch distribution: {' · '.join(f'{k}: {v}' for k, v in sorted(class_dist.items()))}")

st.divider()

# ─── Ingest ───
st.subheader("🚀 Run Pipeline")
st.caption("Step 1: Ingest events → Step 2: Agent processes each → Dashboard shows results")

col_a, col_b = st.columns(2)

with col_a:
    ingest_only = st.button("Step 1: Ingest Only", use_container_width=True)
with col_b:
    ingest_and_process = st.button("Step 1 + 2: Ingest & Process with Agent", type="primary", use_container_width=True)

if ingest_only or ingest_and_process:
    ingested_ids = []
    errors = []

    # Step 1: Ingest
    st.write("**Ingesting events...**")
    progress = st.progress(0)
    status_text = st.empty()

    for i, txn in enumerate(batch):
        status_text.text(f"Ingesting {i + 1}/{len(batch)}: {txn['id']} ({txn['failure_class']})")
        try:
            code, resp = ingest_single(txn)
            if code == 200:
                ingested_ids.append(resp["event_id"])
            elif code == 409:
                errors.append(f"{txn['id']}: duplicate")
            else:
                errors.append(f"{txn['id']}: {resp}")
        except Exception as e:
            errors.append(f"{txn['id']}: {e}")
        progress.progress((i + 1) / len(batch))

    status_text.empty()
    st.success(f"Ingested {len(ingested_ids)} events ({len(errors)} skipped/errors)")

    if errors:
        with st.expander(f"Errors ({len(errors)})"):
            for e in errors:
                st.text(e)

    # Step 2: Agent processing
    if ingest_and_process and ingested_ids:
        st.write("**Running agent pipeline...**")
        progress2 = st.progress(0)
        status_text2 = st.empty()
        results = {"success": 0, "error": 0}

        for i, event_id in enumerate(ingested_ids):
            status_text2.text(f"Agent processing {i + 1}/{len(ingested_ids)}: {event_id[:12]}...")
            try:
                code, resp = process_agent(event_id)
                if code == 200:
                    results["success"] += 1
                    # Show interesting results inline
                    if resp.get("guardrail", {}).get("overridden"):
                        st.info(
                            f"🛡️ **Override** on `{resp.get('transaction_id', event_id[:12])}` — "
                            f"Agent proposed `{resp['agent']['proposed_action']}`, "
                            f"guardrail changed to `{resp['guardrail']['final_action']}`: "
                            f"{resp['guardrail'].get('override_reason', '')}"
                        )
                else:
                    results["error"] += 1
            except Exception as e:
                results["error"] += 1
            progress2.progress((i + 1) / len(ingested_ids))

        status_text2.empty()
        st.success(f"Agent processed {results['success']} events ({results['error']} errors)")

    # Refresh stats
    st.divider()
    st.subheader("📊 Updated Database")
    summary = get_db_counts()
    if summary:
        c1, c2, c3, c4 = st.columns(4)
        c1.metric("Total Events", summary["total_events"])
        c2.metric("Recovered", summary["recovered_count"])
        c3.metric("Pending", summary["pending_count"])
        c4.metric("Exceptions", summary["exception_count"])

    st.info("Open the main dashboard at http://localhost:5173 to see results.")

st.divider()

# ─── Danger Zone ───
with st.expander("⚠️ Danger Zone"):
    st.warning("This will delete ALL data from the database (except config).")
    if st.button("🗑️ Clear All Data", type="secondary"):
        try:
            import subprocess
            result = subprocess.run(
                [
                    "docker", "exec", "recovery_agent_db",
                    "psql", "-U", "recovery", "-d", "recovery_agent",
                    "-c", "TRUNCATE actions, suppressions, audit_ledger, recovery_plans, failure_events CASCADE;"
                ],
                capture_output=True, text=True, timeout=10,
            )
            if result.returncode == 0:
                st.success("All data cleared.")
                st.rerun()
            else:
                st.error(f"Failed: {result.stderr}")
        except Exception as e:
            st.error(f"Error: {e}")

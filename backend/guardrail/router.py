"""Guardrail API — expose ontology and SHACL shapes for transparency."""

from pathlib import Path
from fastapi import APIRouter
from fastapi.responses import PlainTextResponse

router = APIRouter(prefix="/guardrail", tags=["guardrail"])

_ONTOLOGY_DIR = Path(__file__).parent / "ontology"


@router.get("/ontology", response_class=PlainTextResponse)
async def get_ontology():
    """Return the RDF/OWL ontology as Turtle."""
    return (_ONTOLOGY_DIR / "recovery_agent.ttl").read_text()


@router.get("/shapes", response_class=PlainTextResponse)
async def get_shapes():
    """Return the SHACL guardrail shapes as Turtle."""
    return (_ONTOLOGY_DIR / "guardrail_shapes.ttl").read_text()


@router.get("/info")
async def guardrail_info():
    """Return metadata about the SHACL guardrail engine."""
    return {
        "engine": "pyshacl",
        "ontology_format": "RDF/OWL (Turtle)",
        "shapes_format": "SHACL (Turtle)",
        "rules": [
            {"name": "hard_no_retry", "description": "HARD declines must never be retried", "policy": "Visa Core Rules 2024, Mastercard Rules 2024"},
            {"name": "mandate_no_retry", "description": "MANDATE failures must never be retried", "policy": "RBI e-Mandate Framework (DPSS.CO.PD.No.629/2019-20)"},
            {"name": "max_retry_count", "description": "Retry count must not exceed configured maximum", "policy": "Visa (15/30d), Mastercard (10-25/30d), NPCI UPI (5/txn)"},
            {"name": "retry_window", "description": "All retries must complete within the retry window", "policy": "Visa/Mastercard 30-day window, NPCI UPI 48h reversal"},
            {"name": "contact_frequency_cap", "description": "Customer contact count must not exceed maximum", "policy": "RBI Digital Lending Guidelines (RBI/DOR/2022-23/145)"},
            {"name": "customer_opt_out", "description": "Opted-out customers must never be contacted", "policy": "RBI Customer Protection (RBI/DBR/2017-18/15), IT Act 2000 §43A"},
            {"name": "no_email_on_file", "description": "Cannot email if no address on file", "policy": "RBI Digital Lending Guidelines"},
            {"name": "unknown_must_escalate", "description": "UNKNOWN with low confidence must escalate", "policy": "RBI Operational Risk Management Framework"},
            {"name": "kill_switch", "description": "Kill switch halts all automated execution", "policy": "RBI Business Continuity Planning"},
            {"name": "rbi_pre_debit_notification", "description": "Pre-debit notification required 24h before mandate execution", "policy": "RBI e-Mandate Framework, NPCI Circular OC-151"},
            {"name": "card_network_do_not_retry", "description": "Visa/Mastercard 'do not retry' response codes", "policy": "Visa Core Rules 2024, Mastercard Transaction Processing Rules"},
            {"name": "rbi_email_transparency", "description": "Recovery emails must identify entity and include required details", "policy": "RBI Digital Lending Guidelines (RBI/DOR/2022-23/145)"},
        ],
        "regulatory_sources": [
            {"name": "RBI e-Mandate Framework", "ref": "DPSS.CO.PD.No.629/02.01.014/2019-20"},
            {"name": "RBI Customer Protection", "ref": "RBI/DBR/2017-18/15"},
            {"name": "RBI Digital Lending Guidelines", "ref": "RBI/DOR/2022-23/145"},
            {"name": "NPCI UPI Procedural Guidelines", "ref": "NPCI/UPI/OC-79/2023"},
            {"name": "Visa Core Rules 2024", "ref": "Visa Transaction Processing Rules"},
            {"name": "Mastercard Rules 2024", "ref": "Mastercard Transaction Processing Rules"},
        ],
    }

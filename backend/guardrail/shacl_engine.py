"""
SHACL Guardrail Engine — validates agent proposals using RDF ontology + SHACL shapes.

Replaces the hardcoded Python if/else guardrail checks with formally specified
SHACL constraint shapes. Each guardrail rule is a SHACL shape in guardrail_shapes.ttl.

Flow:
  1. Convert AgentProposal + context into an RDF data graph
  2. Load the SHACL shapes graph (9 guardrail rules)
  3. Run pyshacl validation
  4. Map SHACL violations back to GuardrailResult (same interface as engine.py)

The deterministic override logic (what to change the action TO when a rule fires)
stays in Python — SHACL tells us WHAT's wrong, Python decides HOW to fix it.
"""

import logging
from pathlib import Path

from rdflib import Graph, Namespace, Literal, URIRef, RDF
from rdflib.namespace import XSD
import pyshacl

from backend.agent.service import AgentProposal
from backend.guardrail.engine import GuardrailCheck, GuardrailResult

logger = logging.getLogger(__name__)

RA = Namespace("http://razorpay.com/recovery-agent/ontology#")

_ONTOLOGY_DIR = Path(__file__).parent / "ontology"
_SHAPES_GRAPH: Graph | None = None
_ONTOLOGY_GRAPH: Graph | None = None


def _load_shapes(force_reload: bool = False) -> Graph:
    """Load and cache the SHACL shapes graph."""
    global _SHAPES_GRAPH
    if _SHAPES_GRAPH is None or force_reload:
        _SHAPES_GRAPH = Graph()
        _SHAPES_GRAPH.parse(_ONTOLOGY_DIR / "guardrail_shapes.ttl", format="turtle")
        logger.info(f"Loaded SHACL shapes: {len(_SHAPES_GRAPH)} triples")
    return _SHAPES_GRAPH


def _load_ontology() -> Graph:
    """Load and cache the ontology graph."""
    global _ONTOLOGY_GRAPH
    if _ONTOLOGY_GRAPH is None:
        _ONTOLOGY_GRAPH = Graph()
        _ONTOLOGY_GRAPH.parse(_ONTOLOGY_DIR / "recovery_agent.ttl", format="turtle")
        logger.info(f"Loaded ontology: {len(_ONTOLOGY_GRAPH)} triples")
    return _ONTOLOGY_GRAPH


def _build_data_graph(
    proposal: AgentProposal,
    failure_class: str,
    classification_confidence: float,
    confidence_threshold: float,
    max_retries: int,
    retry_window_hours: int,
    max_contacts: int,
    prior_retries: int,
    prior_contacts: int,
    opted_out: bool,
    has_email: bool,
    kill_switch: bool,
    decline_code: str = "",
    instrument_type: str = "",
    amount_paise: int = 0,
) -> Graph:
    """Convert an agent proposal + context into an RDF data graph for SHACL validation."""
    g = Graph()
    g.bind("ra", RA)

    proposal_uri = URIRef(f"http://razorpay.com/recovery-agent/proposals/{proposal.failure_event_id}")
    context_uri = URIRef(f"http://razorpay.com/recovery-agent/contexts/{proposal.failure_event_id}")

    # Proposal node
    g.add((proposal_uri, RDF.type, RA.AgentProposal))
    g.add((proposal_uri, RA.proposedAction, Literal(proposal.proposed_action, datatype=XSD.string)))
    g.add((proposal_uri, RA.confidence, Literal(float(proposal.confidence), datatype=XSD.float)))
    g.add((proposal_uri, RA.reasoning, Literal(proposal.reasoning, datatype=XSD.string)))
    g.add((proposal_uri, RA.hasContext, context_uri))

    # Retry schedule metadata
    if proposal.retry_schedule:
        g.add((proposal_uri, RA.retryCount, Literal(len(proposal.retry_schedule), datatype=XSD.integer)))
        g.add((proposal_uri, RA.maxRetryHours, Literal(float(max(proposal.retry_schedule)), datatype=XSD.float)))
    else:
        g.add((proposal_uri, RA.retryCount, Literal(0, datatype=XSD.integer)))
        g.add((proposal_uri, RA.maxRetryHours, Literal(0.0, datatype=XSD.float)))

    # Context node
    g.add((context_uri, RDF.type, RA.FailureContext))
    g.add((context_uri, RA.failureClass, Literal(failure_class, datatype=XSD.string)))
    g.add((context_uri, RA.classificationConfidence, Literal(float(classification_confidence), datatype=XSD.float)))
    g.add((context_uri, RA.priorRetries, Literal(int(prior_retries), datatype=XSD.integer)))
    g.add((context_uri, RA.priorContacts, Literal(int(prior_contacts), datatype=XSD.integer)))
    g.add((context_uri, RA.customerOptedOut, Literal(opted_out, datatype=XSD.boolean)))
    g.add((context_uri, RA.hasEmail, Literal(has_email, datatype=XSD.boolean)))
    g.add((context_uri, RA.killSwitch, Literal(kill_switch, datatype=XSD.boolean)))
    g.add((context_uri, RA.maxRetries, Literal(int(max_retries), datatype=XSD.integer)))
    g.add((context_uri, RA.retryWindowHours, Literal(int(retry_window_hours), datatype=XSD.integer)))
    g.add((context_uri, RA.maxContacts, Literal(int(max_contacts), datatype=XSD.integer)))
    g.add((context_uri, RA.confidenceThreshold, Literal(float(confidence_threshold), datatype=XSD.float)))

    if decline_code:
        g.add((context_uri, RA.declineCode, Literal(decline_code, datatype=XSD.string)))
    if instrument_type:
        g.add((context_uri, RA.instrumentType, Literal(instrument_type, datatype=XSD.string)))
    if amount_paise:
        g.add((context_uri, RA.amountPaise, Literal(int(amount_paise), datatype=XSD.integer)))

    return g


# Map SHACL shape names to override logic
_OVERRIDE_ACTIONS: dict[str, dict] = {
    "hard_no_retry": {
        "needs_email": True,
        "fallback_action": "CONTACT_EMAIL",
        "escalate_action": "ESCALATE_HUMAN",
        "clear_retry": True,
    },
    "mandate_no_retry": {
        "needs_email": True,
        "fallback_action": "REAUTH_REQUEST",
        "escalate_action": "ESCALATE_HUMAN",
        "clear_retry": True,
    },
    "max_retry_count": {
        "needs_email": True,
        "fallback_action": "CONTACT_EMAIL",
        "escalate_action": "ESCALATE_HUMAN",
        "clear_retry": True,
    },
    "retry_window": {
        "needs_email": True,
        "fallback_action": "CONTACT_EMAIL",
        "escalate_action": "ESCALATE_HUMAN",
        "clear_retry": True,
    },
    "contact_frequency_cap": {
        "suppress_email": True,
    },
    "customer_opt_out": {
        "force_action": "ESCALATE_HUMAN",
        "clear_email": True,
    },
    "no_email_on_file": {
        "force_action": "ESCALATE_HUMAN",
        "clear_email": True,
    },
    "unknown_must_escalate": {
        "force_action": "ESCALATE_HUMAN",
        "clear_retry": True,
        "clear_email": True,
    },
    "kill_switch": {
        # Kill switch is just a flag — execution layer checks it separately
    },
    "rbi_pre_debit_notification": {
        "needs_email": True,
        "fallback_action": "REAUTH_REQUEST",
        "escalate_action": "ESCALATE_HUMAN",
        "clear_retry": True,
    },
    "card_network_do_not_retry": {
        "needs_email": True,
        "fallback_action": "CONTACT_EMAIL",
        "escalate_action": "ESCALATE_HUMAN",
        "clear_retry": True,
    },
    "rbi_email_transparency": {
        # Informational — no override, just audit flag
    },
}

# All rule names in evaluation order
_ALL_RULES = [
    "hard_no_retry",
    "mandate_no_retry",
    "max_retry_count",
    "retry_window",
    "contact_frequency_cap",
    "customer_opt_out",
    "no_email_on_file",
    "unknown_must_escalate",
    "kill_switch",
    "rbi_pre_debit_notification",
    "card_network_do_not_retry",
    "rbi_email_transparency",
]


def _extract_shape_name(result_graph: Graph, result_node, shapes_graph: Graph) -> str | None:
    """Extract the shape name from a SHACL validation result."""
    SH = Namespace("http://www.w3.org/ns/shacl#")

    for source in result_graph.objects(result_node, SH.sourceShape):
        # sh:name lives in the shapes graph, not the results graph
        for name in shapes_graph.objects(source, SH.name):
            return str(name)
        # Also check results graph (some pyshacl versions copy it)
        for name in result_graph.objects(source, SH.name):
            return str(name)

    return None


def validate_proposal_shacl(
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
    decline_code: str = "",
    instrument_type: str = "",
    amount_paise: int = 0,
) -> GuardrailResult:
    """
    Validate an agent proposal using SHACL shapes.

    Same interface as engine.validate_proposal — drop-in replacement.
    SHACL determines which rules are violated, Python applies the overrides.
    """
    shapes_graph = _load_shapes()
    ontology_graph = _load_ontology()

    data_graph = _build_data_graph(
        proposal=proposal,
        failure_class=failure_class,
        classification_confidence=classification_confidence,
        confidence_threshold=confidence_threshold,
        max_retries=max_retries,
        retry_window_hours=retry_window_hours,
        max_contacts=max_contacts,
        prior_retries=prior_retries,
        prior_contacts=prior_contacts,
        opted_out=opted_out,
        has_email=has_email,
        kill_switch=kill_switch,
        decline_code=decline_code,
        instrument_type=instrument_type,
        amount_paise=amount_paise,
    )

    # Merge ontology into data graph so class hierarchies are available
    combined = data_graph + ontology_graph

    # Run SHACL validation
    conforms, results_graph, results_text = pyshacl.validate(
        data_graph=combined,
        shacl_graph=shapes_graph,
        advanced=True,  # Enable SPARQL-based constraints
        allow_infering=False,
    )

    # Parse violations from the results graph
    SH = Namespace("http://www.w3.org/ns/shacl#")
    violated_rules: dict[str, str] = {}  # rule_name -> message

    for result_node in results_graph.subjects(RDF.type, SH.ValidationResult):
        severity = None
        for sev in results_graph.objects(result_node, SH.resultSeverity):
            severity = sev

        # Only care about violations
        if severity != SH.Violation:
            continue

        shape_name = _extract_shape_name(results_graph, result_node, shapes_graph)
        message = ""
        for msg in results_graph.objects(result_node, SH.resultMessage):
            message = str(msg)
            break

        if shape_name and shape_name not in violated_rules:
            violated_rules[shape_name] = message

    logger.info(
        f"SHACL validation for {proposal.failure_event_id}: "
        f"conforms={conforms}, violations={list(violated_rules.keys())}"
    )

    # Build checks list (same format as engine.py)
    checks: list[GuardrailCheck] = []
    overridden = False
    override_reason = None
    final_action = proposal.proposed_action
    final_retry_schedule = proposal.retry_schedule
    final_email_draft = proposal.email_draft

    for rule_name in _ALL_RULES:
        if rule_name in violated_rules:
            checks.append(GuardrailCheck(
                rule_name=rule_name,
                rule_version=1,
                passed=False,
                detail=violated_rules[rule_name],
            ))

            # Apply override logic
            override_spec = _OVERRIDE_ACTIONS.get(rule_name, {})

            if "force_action" in override_spec:
                if final_action != override_spec["force_action"]:
                    overridden = True
                    override_reason = violated_rules[rule_name]
                    final_action = override_spec["force_action"]

            elif "fallback_action" in override_spec:
                overridden = True
                override_reason = violated_rules[rule_name]
                if override_spec.get("needs_email") and has_email and not opted_out:
                    final_action = override_spec["fallback_action"]
                else:
                    final_action = override_spec.get("escalate_action", "ESCALATE_HUMAN")

            elif "suppress_email" in override_spec:
                overridden = True
                override_reason = violated_rules[rule_name]
                final_email_draft = None

            if override_spec.get("clear_retry"):
                final_retry_schedule = None
            if override_spec.get("clear_email"):
                final_email_draft = None
        else:
            checks.append(GuardrailCheck(
                rule_name=rule_name,
                rule_version=1,
                passed=True,
            ))

    # Handle retry schedule clamping for retry_window (partial violation)
    if final_action == "RETRY" and final_retry_schedule and "retry_window" not in violated_rules:
        clamped = [h for h in final_retry_schedule if h <= retry_window_hours]
        if len(clamped) < len(final_retry_schedule):
            final_retry_schedule = clamped if clamped else None
            if not final_retry_schedule:
                overridden = True
                override_reason = "All proposed retries exceed retry window."
                final_action = "CONTACT_EMAIL" if has_email and not opted_out else "ESCALATE_HUMAN"

    # Clamp retry count
    if final_action == "RETRY" and final_retry_schedule:
        remaining = max_retries - prior_retries
        if remaining > 0 and len(final_retry_schedule) > remaining:
            final_retry_schedule = final_retry_schedule[:remaining]

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


def get_shacl_report(
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
    decline_code: str = "",
    instrument_type: str = "",
    amount_paise: int = 0,
) -> dict:
    """
    Return the raw SHACL validation report as a serializable dict.
    Useful for the dashboard / audit ledger to show the formal validation.
    """
    shapes_graph = _load_shapes()
    ontology_graph = _load_ontology()

    data_graph = _build_data_graph(
        proposal=proposal,
        failure_class=failure_class,
        classification_confidence=classification_confidence,
        confidence_threshold=confidence_threshold,
        max_retries=max_retries,
        retry_window_hours=retry_window_hours,
        max_contacts=max_contacts,
        prior_retries=prior_retries,
        prior_contacts=prior_contacts,
        opted_out=opted_out,
        has_email=has_email,
        kill_switch=kill_switch,
        decline_code=decline_code,
        instrument_type=instrument_type,
        amount_paise=amount_paise,
    )

    combined = data_graph + ontology_graph

    conforms, results_graph, results_text = pyshacl.validate(
        data_graph=combined,
        shacl_graph=shapes_graph,
        advanced=True,
        allow_infering=False,
    )

    # Serialize the data graph as Turtle for audit
    data_turtle = data_graph.serialize(format="turtle")

    return {
        "conforms": conforms,
        "results_text": results_text,
        "data_graph_turtle": data_turtle,
        "ontology": "recovery_agent.ttl",
        "shapes": "guardrail_shapes.ttl",
        "engine": "pyshacl",
    }

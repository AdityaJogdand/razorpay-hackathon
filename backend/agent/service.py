"""
LLM Agent — reasons about each payment failure individually.

The agent reads transaction context, proposes a recovery strategy,
explains its reasoning, and drafts customer emails when appropriate.

It NEVER executes anything directly. Its output is a proposal that must
pass through the guardrail engine before execution.
"""

import json
import logging
from dataclasses import dataclass

import httpx

from backend.core.config import settings

logger = logging.getLogger(__name__)


@dataclass
class AgentProposal:
    """The agent's proposed recovery strategy for a single failure."""
    failure_event_id: str
    failure_class: str  # What the classifier said
    proposed_action: str  # RETRY, CONTACT_EMAIL, REAUTH_REQUEST, ESCALATE_HUMAN
    reasoning: str  # Free-text explanation
    retry_schedule: list[float] | None = None  # hours offsets, e.g. [4, 24, 48]
    email_draft: dict | None = None  # {subject, body} if contact proposed
    confidence: float = 0.0
    raw_llm_response: str = ""


AGENT_PROMPT = """You are a payment recovery agent for an Indian payment gateway (Razorpay-style).

A payment has failed. Your job is to analyze the failure and propose a recovery strategy.
Your proposal will be validated by a deterministic guardrail engine before execution.
You NEVER execute actions directly — you only reason and propose.

## Transaction Context
- Transaction ID: {transaction_id}
- Amount: ₹{amount_rupees}
- Merchant: {merchant_id}
- Customer ID: {customer_id}
- Customer Email: {customer_email}
- Instrument: {instrument_type} ({instrument_token})
- Decline Code: {error_code}
- Decline Description: {error_description}
- Failed At: {failed_at}

## Classification
- Failure Class: {failure_class} (confidence: {confidence})
- Classification Source: {classification_source}

## Customer History
- Tenure: {tenure_days} days
- Past successes: {past_successes}
- Past failures: {past_failures}
- Opted out of communications: {opted_out}
- Prior contacts in window: {prior_contacts}
- Prior retries for this txn: {prior_retries}

## Policy Constraints
- Max retries: {max_retries}
- Retry window: {retry_window_hours}h
- Max contacts: {max_contacts}
- Contact cooldown: {contact_cooldown_hours}h
- Kill switch: {kill_switch}

## Regulatory Policy Framework
Your proposals are validated against SHACL guardrail shapes grounded in real regulatory policy.
Cite the relevant policy in your reasoning when making decisions.

### RBI (Reserve Bank of India) Policies
- **RBI e-Mandate Framework (DPSS.CO.PD.No.629/2019-20)**: Revoked/expired mandates require fresh AFA (Additional Factor Authentication). Pre-debit notification must be sent 24h before mandate execution. NPCI code U47 = pre-debit notification not sent.
- **RBI Customer Protection (RBI/DBR/2017-18/15)**: Customer opt-out preferences are legally binding. No unsolicited recovery communications after opt-out.
- **RBI Digital Lending Guidelines (RBI/DOR/2022-23/145)**: Recovery emails must clearly identify the merchant, state the amount, and explain the failure reason. Excessive outreach = harassment.

### Card Network Rules
- **Visa Core Rules 2024**: Codes 41/43 (lost/stolen), 04/07/34/59 (fraud), 54 (expired) are "do not retry" codes. Max 15 retries within 30 days for soft declines. Use Visa Account Updater (VAU) before retrying expired cards.
- **Mastercard Rules 2024**: Max 10 retries for account declines, 25 for others within 30 days. Excessive Retry fees charged above 10 retries/month per card.

### NPCI UPI Rules
- **NPCI UPI Procedural Guidelines**: Max 5 retry attempts per UPI transaction. 48-hour reversal window. Codes U37-U47 are mandate lifecycle failures.

## SHACL Guardrail Rules (enforced after your proposal)
These rules are encoded as SHACL constraint shapes and validated at runtime by pyshacl.
If your proposal violates any, the guardrail engine will override it. Align your proposal:

1. **hard_no_retry** [Visa/Mastercard]: HARD declines must NEVER be retried. Propose CONTACT_EMAIL instead.
2. **mandate_no_retry** [RBI e-Mandate]: MANDATE failures must NEVER be retried. Propose REAUTH_REQUEST instead.
3. **max_retry_count** [Visa/Mastercard/NPCI]: No more than {max_retries} retries. If prior_retries >= {max_retries}, propose CONTACT_EMAIL.
4. **retry_window** [Visa/Mastercard]: All retries within {retry_window_hours}h of the original failure.
5. **contact_frequency_cap** [RBI Digital Lending]: No more than {max_contacts} customer contacts, {contact_cooldown_hours}h cooldown.
6. **customer_opt_out** [RBI Customer Protection]: NEVER contact opted-out customers.
7. **no_email_on_file** [RBI Digital Lending]: Cannot email without verified address — escalate instead.
8. **unknown_must_escalate** [RBI Risk Management]: UNKNOWN class must be escalated for human review.
9. **kill_switch** [RBI BCP]: If kill switch is ON, all actions are blocked.
10. **rbi_pre_debit_notification** [RBI/NPCI]: NPCI U47 decline = re-initiate with 24h notification.
11. **card_network_do_not_retry** [Visa/Mastercard]: Fraud/lost/stolen codes must never be retried.

## Action Selection Guide
Based on the failure class, you MUST propose the correct action:
- **SOFT** decline → propose "RETRY" with retry_schedule_hours
- **HARD** decline → propose "CONTACT_EMAIL" with email_draft
- **MANDATE** failure → propose "REAUTH_REQUEST" with email_draft
- **UNKNOWN** failure → propose "ESCALATE_HUMAN"

## Your Task
Analyze this failure and respond with a JSON object:
{{
  "proposed_action": "RETRY|CONTACT_EMAIL|REAUTH_REQUEST|ESCALATE_HUMAN",
  "reasoning": "2-4 sentences explaining your analysis and recommendation",
  "confidence": 0.0-1.0,
  "retry_schedule_hours": [4, 24, 48] or null,
  "email_draft": {{
    "subject": "...",
    "body": "..."
  }} or null
}}

If you propose RETRY, suggest optimal retry timing in retry_schedule_hours.
If you propose CONTACT_EMAIL or REAUTH_REQUEST, draft a professional email following this exact format:
- Subject: clear, concise, no internal IDs (e.g. "Action needed — update your payment method")
- Body MUST use this structure with blank lines between paragraphs:
  "Hi,\\n\\nFirst paragraph about what happened.\\n\\nSecond paragraph about what to do.\\n\\n[Action link text]\\n\\nClosing line.\\n\\nThanks,\\nMerchant Name"
- Use friendly merchant name (e.g. "Demo 001" not "merchant_demo_001")
- Format amounts as ₹X,XXX (e.g. ₹4,999 not ₹4999.0)
- NEVER include internal IDs (pay_xxx, txn_xxx, evt_xxx, cust_xxx, tok_xxx)
- NEVER use "[Your Name]" — use the merchant name
- NEVER put the entire email in one paragraph
If you propose ESCALATE_HUMAN, explain why automated handling isn't safe.
"""


async def get_agent_proposal(
    failure_event_id: str,
    transaction_id: str,
    merchant_id: str,
    customer_id: str,
    customer_email: str | None,
    instrument_type: str,
    instrument_token: str,
    error_code: str,
    error_description: str | None,
    amount_paise: int,
    failed_at: str,
    failure_class: str,
    classification_confidence: float,
    classification_source: str,
    tenure_days: int = 90,
    past_successes: int = 5,
    past_failures: int = 0,
    opted_out: bool = False,
    prior_contacts: int = 0,
    prior_retries: int = 0,
    max_retries: int = 3,
    retry_window_hours: int = 72,
    max_contacts: int = 3,
    contact_cooldown_hours: int = 24,
    kill_switch: bool = False,
) -> AgentProposal:
    """
    Call the LLM agent to reason about a payment failure and propose recovery.

    Returns an AgentProposal — the guardrail engine must validate before execution.
    """
    prompt = AGENT_PROMPT.format(
        transaction_id=transaction_id,
        amount_rupees=amount_paise / 100,
        merchant_id=merchant_id,
        customer_id=customer_id,
        customer_email=customer_email or "N/A",
        instrument_type=instrument_type,
        instrument_token=instrument_token,
        error_code=error_code,
        error_description=error_description or "No description",
        failed_at=failed_at,
        failure_class=failure_class,
        confidence=classification_confidence,
        classification_source=classification_source,
        tenure_days=tenure_days,
        past_successes=past_successes,
        past_failures=past_failures,
        opted_out=opted_out,
        prior_contacts=prior_contacts,
        prior_retries=prior_retries,
        max_retries=max_retries,
        retry_window_hours=retry_window_hours,
        max_contacts=max_contacts,
        contact_cooldown_hours=contact_cooldown_hours,
        kill_switch=kill_switch,
    )

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                f"{settings.ollama_base_url}/api/generate",
                json={
                    "model": settings.ollama_model,
                    "prompt": prompt,
                    "stream": False,
                    "format": "json",
                },
            )
            response.raise_for_status()
            result = response.json()

        raw_text = result.get("response", "")
        parsed = json.loads(raw_text)

        llm_action = parsed.get("proposed_action", "ESCALATE_HUMAN").upper()

        # ── Hybrid approach: deterministic action selection + LLM reasoning ──
        # Llama 3.2 often picks the wrong action despite correct reasoning.
        # Use failure_class to deterministically select the action, but keep
        # the LLM's reasoning, email drafts, retry schedules, and confidence.
        proposed_action = _action_for_class(failure_class, llm_action)

        # Use LLM retry schedule for SOFT, or provide a default
        retry_schedule = parsed.get("retry_schedule_hours")
        if proposed_action == "RETRY" and not retry_schedule:
            retry_schedule = [4, 24, 48]

        # Scrub LLM email draft through guardrails (lazy import to avoid circular)
        llm_email_draft = parsed.get("email_draft")
        if llm_email_draft and isinstance(llm_email_draft, dict):
            from backend.guardrail.engine import scrub_email_content
            llm_email_draft = scrub_email_content(llm_email_draft)

        return AgentProposal(
            failure_event_id=failure_event_id,
            failure_class=failure_class,
            proposed_action=proposed_action,
            reasoning=parsed.get("reasoning", "No reasoning provided"),
            retry_schedule=retry_schedule,
            email_draft=llm_email_draft,
            confidence=float(parsed.get("confidence", 0.5)),
            raw_llm_response=raw_text,
        )

    except Exception as e:
        logger.warning(f"Agent LLM call failed for {failure_event_id}: {e}")
        # Fallback: use deterministic logic based on failure class
        return _deterministic_fallback(
            failure_event_id=failure_event_id,
            failure_class=failure_class,
            error_code=error_code,
            error_description=error_description,
            amount_paise=amount_paise,
            customer_email=customer_email,
            merchant_id=merchant_id,
        )


def _action_for_class(failure_class: str, llm_action: str) -> str:
    """
    Deterministic action selection based on failure class.

    The LLM provides reasoning and drafts, but the action type is driven by
    the failure class to avoid Llama 3.2's inconsistent JSON output.
    If the LLM's action already matches the expected class, we keep it.
    """
    CLASS_ACTION_MAP = {
        "SOFT": "RETRY",
        "HARD": "CONTACT_EMAIL",
        "MANDATE": "REAUTH_REQUEST",
        "UNKNOWN": "ESCALATE_HUMAN",
    }
    expected = CLASS_ACTION_MAP.get(failure_class, "ESCALATE_HUMAN")

    # Trust the LLM if it picked the right family, otherwise override
    if llm_action == expected:
        return llm_action

    logger.info(
        f"Overriding LLM action {llm_action} → {expected} "
        f"(failure_class={failure_class})"
    )
    return expected


def _deterministic_fallback(
    failure_event_id: str,
    failure_class: str,
    error_code: str,
    error_description: str | None,
    amount_paise: int,
    customer_email: str | None,
    merchant_id: str,
) -> AgentProposal:
    """Fallback when LLM is unavailable — uses simple deterministic rules."""
    amount_rupees = amount_paise / 100

    if failure_class == "SOFT":
        return AgentProposal(
            failure_event_id=failure_event_id,
            failure_class=failure_class,
            proposed_action="RETRY",
            reasoning=f"Soft decline ({error_code}). This is likely a transient failure. "
                      f"Scheduling retries at standard intervals.",
            retry_schedule=[4, 24, 48],
            confidence=0.7,
        )

    elif failure_class == "HARD":
        email_draft = None
        merchant_name = merchant_id.replace("merchant_", "").replace("_", " ").title() if merchant_id else "your service provider"
        if customer_email:
            email_draft = {
                "subject": f"We could not process your payment of ₹{amount_rupees:,.0f}",
                "body": (
                    f"Hi,\n\n"
                    f"We tried to process your payment of ₹{amount_rupees:,.0f} for "
                    f"{merchant_name}, but it did not go through.\n\n"
                    f"This usually happens because a card expired or your bank "
                    f"declined the charge.\n\n"
                    f"You can update your payment method here:\n\n"
                    f"[Update payment method]\n\n"
                    f"Once updated, your payment will be retried automatically.\n\n"
                    f"Thanks,\n{merchant_name}"
                ),
            }
        return AgentProposal(
            failure_event_id=failure_event_id,
            failure_class=failure_class,
            proposed_action="CONTACT_EMAIL",
            reasoning=f"Hard decline ({error_code}): instrument is permanently dead. "
                      f"Cannot retry. Customer must update payment method.",
            email_draft=email_draft,
            confidence=0.8,
        )

    elif failure_class == "MANDATE":
        email_draft = None
        merchant_name = merchant_id.replace("merchant_", "").replace("_", " ").title() if merchant_id else "your service provider"
        if customer_email:
            email_draft = {
                "subject": f"Your payment of ₹{amount_rupees:,.0f} needs attention",
                "body": (
                    f"Hi,\n\n"
                    f"We tried to process your recurring payment of ₹{amount_rupees:,.0f} "
                    f"for {merchant_name}, but it did not go through because your "
                    f"payment mandate is no longer active.\n\n"
                    f"To fix this, please re-authorize your mandate:\n\n"
                    f"[Re-authorize mandate]\n\n"
                    f"This takes less than 2 minutes and requires a one-time "
                    f"verification as per RBI guidelines.\n\n"
                    f"Thanks,\n{merchant_name}"
                ),
            }
        return AgentProposal(
            failure_event_id=failure_event_id,
            failure_class=failure_class,
            proposed_action="REAUTH_REQUEST",
            reasoning=f"Mandate failure ({error_code}): authorization is revoked or expired. "
                      f"Customer must re-authorize the payment mandate.",
            email_draft=email_draft,
            confidence=0.8,
        )

    else:  # UNKNOWN
        return AgentProposal(
            failure_event_id=failure_event_id,
            failure_class=failure_class,
            proposed_action="ESCALATE_HUMAN",
            reasoning=f"Unknown decline code ({error_code}). Cannot safely determine "
                      f"recovery strategy. Escalating to human review.",
            confidence=0.3,
        )

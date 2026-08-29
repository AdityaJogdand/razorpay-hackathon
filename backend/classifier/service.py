"""
Triage classifier: rules-based lookup + Ollama LLM fallback for unmapped codes.

Per N1: the LLM never touches money-moving calls. It only classifies.
"""

import logging

import httpx

from backend.core.config import settings
from backend.models.enums import FailureClass
from backend.classifier.taxonomy import classify_by_rules

logger = logging.getLogger(__name__)

LLM_CONFIDENCE_THRESHOLD = 0.7

CLASSIFICATION_PROMPT = """You are a payment decline code classifier for an Indian payment gateway.

Given a decline code and description, classify it into exactly one of these categories:
- HARD: The payment instrument is permanently dead (expired card, closed account, invalid number, stolen card)
- SOFT: Transient failure that may succeed on retry (insufficient funds, timeout, issuer unavailable, rate limit)
- MANDATE: UPI or e-mandate lifecycle issue (mandate revoked, paused, expired, not found)
- UNKNOWN: Ambiguous or insufficient information to classify

Respond with ONLY a JSON object: {{"class": "HARD|SOFT|MANDATE|UNKNOWN", "confidence": 0.0-1.0, "reasoning": "brief explanation"}}

Decline code: {code}
Description: {description}
"""


async def classify(
    raw_error_code: str,
    raw_error_description: str | None = None,
) -> tuple[FailureClass, str, float]:
    """
    Classify a decline code.

    Returns: (failure_class, source, confidence)
      - source is "RULES" or "LLM"
      - confidence is 1.0 for rules, model confidence for LLM
    """
    # Step 1: Try deterministic rules lookup
    failure_class, source = classify_by_rules(raw_error_code)
    if failure_class is not None:
        return failure_class, "RULES", 1.0

    # Step 2: Fall back to LLM for unmapped codes
    try:
        llm_class, llm_confidence = await _classify_with_llm(
            raw_error_code, raw_error_description or ""
        )
        if llm_confidence >= LLM_CONFIDENCE_THRESHOLD:
            return llm_class, "LLM", llm_confidence
        else:
            logger.info(
                f"LLM confidence {llm_confidence:.2f} below threshold for code={raw_error_code}, "
                f"degrading to UNKNOWN"
            )
            return FailureClass.UNKNOWN, "LLM", llm_confidence
    except Exception as e:
        logger.warning(f"LLM classification failed for code={raw_error_code}: {e}")
        return FailureClass.UNKNOWN, "FALLBACK", 0.0


async def _classify_with_llm(code: str, description: str) -> tuple[FailureClass, float]:
    """Call Ollama to classify an unmapped decline code."""
    prompt = CLASSIFICATION_PROMPT.format(code=code, description=description)

    async with httpx.AsyncClient(timeout=30.0) as client:
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

    import json
    parsed = json.loads(raw_text)

    class_str = parsed.get("class", "UNKNOWN").upper()
    confidence = float(parsed.get("confidence", 0.0))

    try:
        failure_class = FailureClass(class_str)
    except ValueError:
        failure_class = FailureClass.UNKNOWN
        confidence = 0.0

    return failure_class, confidence

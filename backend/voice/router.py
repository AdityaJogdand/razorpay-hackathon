"""Voice recovery module – Hinglish call script generation + ElevenLabs TTS."""

from __future__ import annotations

import os
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.config import settings
from backend.core.database import get_db
from backend.models.tables import FailureEvent

router = APIRouter(prefix="/voice", tags=["voice"])

# ── Available voices ────────────────────────────────────────────────────────

VOICES = [
    {"voice_id": "EXAVITQu4vr4xnSDxMaL", "name": "Sarah", "gender": "female", "style": "reassuring"},
    {"voice_id": "JBFqnCBsd6RMkjVDRZzb", "name": "George", "gender": "male", "style": "warm"},
    {"voice_id": "Xb7hH8MSUJpSbSDYk0k2", "name": "Alice", "gender": "female", "style": "clear"},
    {"voice_id": "IKne3meq5aSn9XLyUdCD", "name": "Charlie", "gender": "male", "style": "confident"},
    {"voice_id": "CwhRBWXzGAHq8TQ4Fs17", "name": "Roger", "gender": "male", "style": "casual"},
]

DEFAULT_VOICE_ID = "EXAVITQu4vr4xnSDxMaL"


# ── Request / response models ──────────────────────────────────────────────

class SynthesizeRequest(BaseModel):
    script: str
    voice_id: str | None = None


# ── Helpers ─────────────────────────────────────────────────────────────────

def _fallback_script(amount_display: str, failure_class: str) -> str:
    """Deterministic fallback when Ollama is unavailable."""
    if failure_class == "HARD":
        return (
            f"Hello! I'm calling from Razorpay regarding your recent payment of {amount_display} rupees. "
            f"Unfortunately, the payment could not be processed. "
            f"This usually requires a quick check with your bank or card provider to resolve. "
            f"Once that's sorted, you should be able to complete the payment without any issues. "
            f"If you need any help, our support team is here for you. Thank you!"
        )
    elif failure_class == "MANDATE":
        return (
            f"Hello! I'm calling from Razorpay about your auto-payment of {amount_display} rupees. "
            f"It looks like the payment couldn't go through due to a mandate issue. "
            f"Could you please check your bank app and verify that your mandate is still active? "
            f"If it has expired, you'll need to set up a new one. "
            f"Feel free to reach out if you need any assistance. Thank you!"
        )
    else:
        return (
            f"Hello! I'm calling from Razorpay regarding your payment of {amount_display} rupees. "
            f"It looks like the payment didn't go through this time. "
            f"Don't worry, this seems to be a temporary issue. "
            f"Could you please try the payment once more? "
            f"If the problem persists, our team is ready to help. Thank you!"
        )


async def _generate_script_via_ollama(amount_display: str, failure_class: str) -> str | None:
    """Call local Ollama to generate a Hinglish recovery script."""
    prompt = (
        f"You are a friendly Razorpay customer support agent making a phone call. "
        f"Generate a short, professional English voice call script to help a customer "
        f"whose payment of {amount_display} rupees failed.\n\n"
        f"Rules:\n"
        f"- Start with 'Hello' and introduce yourself as calling from Razorpay\n"
        f"- Mention the amount naturally\n"
        f"- Do NOT use technical terms like '{failure_class}', 'failure type', 'transaction', or 'error code'\n"
        f"- Explain the issue in simple everyday language a customer would understand\n"
        f"- Suggest a clear next step (retry, contact bank, check mandate, etc.)\n"
        f"- End politely with thanks\n"
        f"- Keep it 4-5 sentences, warm and conversational\n"
        f"- Do NOT wrap the script in quotes\n"
        f"- Output ONLY the script text, nothing else"
    )
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{settings.ollama_base_url}/api/generate",
                json={"model": settings.ollama_model, "prompt": prompt, "stream": False},
            )
            resp.raise_for_status()
            text = resp.json().get("response", "").strip()
            # Strip wrapping quotes if present
            if text.startswith('"') and text.endswith('"'):
                text = text[1:-1].strip()
            return text
    except Exception:
        return None


# ── Endpoints ───────────────────────────────────────────────────────────────

@router.post("/generate-script/{event_id}")
async def generate_script(event_id: UUID, db: AsyncSession = Depends(get_db)):
    """Generate a Hinglish recovery call script for a failure event."""
    result = await db.execute(select(FailureEvent).where(FailureEvent.id == event_id))
    event = result.scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="Failure event not found")

    amount_rupees = event.amount_paise / 100
    amount_display = f"{amount_rupees:,.2f}"
    failure_class = event.failure_class.value if hasattr(event.failure_class, "value") else str(event.failure_class)

    script = await _generate_script_via_ollama(amount_display, failure_class)
    if not script:
        script = _fallback_script(amount_display, failure_class)

    return {
        "event_id": str(event.id),
        "script": script,
        "amount_display": f"{amount_display} INR",
        "customer_email": event.customer_email,
        "failure_class": failure_class,
    }


@router.post("/synthesize/{event_id}")
async def synthesize(event_id: UUID, body: SynthesizeRequest):
    """Convert a script to audio via ElevenLabs TTS."""
    api_key = settings.elevenlabs_api_key
    if not api_key:
        return {
            "mock": True,
            "message": "ElevenLabs API key not configured. Set ELEVENLABS_API_KEY in .env",
        }

    voice_id = body.voice_id or DEFAULT_VOICE_ID

    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(
            f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}",
            headers={
                "xi-api-key": api_key,
                "Content-Type": "application/json",
            },
            json={
                "text": body.script,
                "model_id": "eleven_v3",
            },
        )
        if resp.status_code != 200:
            raise HTTPException(
                status_code=resp.status_code,
                detail=f"ElevenLabs API error: {resp.text}",
            )

        return StreamingResponse(
            content=iter([resp.content]),
            media_type="audio/mpeg",
        )


@router.get("/voices")
async def list_voices():
    """Return available voice options for TTS synthesis."""
    return {"voices": VOICES}

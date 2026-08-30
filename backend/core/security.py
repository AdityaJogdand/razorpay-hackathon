"""
Security utilities — API key verification, PII masking, input validation.
"""

import re
from fastapi import Security, HTTPException, status
from fastapi.security import APIKeyHeader

from backend.core.config import settings

api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)


async def verify_api_key(api_key: str | None = Security(api_key_header)) -> str:
    """Verify the API key from request headers."""
    if not api_key or api_key != settings.api_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing API key",
        )
    return api_key


def mask_email(email: str | None) -> str:
    """Mask email address for API responses. user@domain.com -> u***r@domain.com"""
    if not email or "@" not in email:
        return email or ""
    local, domain = email.rsplit("@", 1)
    if len(local) <= 2:
        masked_local = local[0] + "***"
    else:
        masked_local = local[0] + "***" + local[-1]
    return f"{masked_local}@{domain}"


def mask_token(token: str | None) -> str:
    """Mask instrument token, showing only last 4 chars."""
    if not token:
        return ""
    if len(token) <= 4:
        return "****"
    return "****" + token[-4:]


def validate_uuid(value: str) -> str:
    """Validate UUID format. Raises HTTPException if invalid."""
    uuid_pattern = re.compile(
        r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
        re.IGNORECASE,
    )
    if not uuid_pattern.match(value):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid UUID format",
        )
    return value

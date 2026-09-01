from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from backend.mandate.router import (
    _generate_mandate_email,
    _has_recovered,
    _require_wait_elapsed,
)
from backend.mandate.sequencer import MandateSubType, SequenceStepType, build_sequence
from backend.models.enums import ActionStatus, ActionType


def _action(step_number: int, status: ActionStatus, *, executed_at=None):
    return SimpleNamespace(
        action_type=ActionType.REAUTH_REQUEST,
        status=status,
        scheduled_at=datetime.now(timezone.utc) - timedelta(hours=49),
        executed_at=executed_at,
        outcome={"step_number": step_number},
    )


def test_revoked_sequence_is_email_then_wait_then_follow_up():
    sequence = build_sequence(MandateSubType.REVOKED, 12_000, has_email=True)

    assert [step.step_type for step in sequence.steps[:3]] == [
        SequenceStepType.SEND_REAUTH_EMAIL,
        SequenceStepType.WAIT,
        SequenceStepType.SEND_REAUTH_EMAIL,
    ]


def test_wait_blocks_follow_up_until_its_full_delay_has_elapsed():
    sequence = build_sequence(MandateSubType.REVOKED, 12_000, has_email=True)
    first_email = _action(
        1,
        ActionStatus.SUCCEEDED,
        executed_at=datetime.now(timezone.utc) - timedelta(hours=47),
    )

    with pytest.raises(HTTPException, match="Waiting period is still active"):
        _require_wait_elapsed(sequence.steps[1], sequence.steps, [first_email], datetime.now(timezone.utc))


def test_follow_up_copy_is_distinct_from_the_initial_email():
    initial = _generate_mandate_email(MandateSubType.REVOKED, 12_000, "merchant_demo_001", 1)
    follow_up = _generate_mandate_email(MandateSubType.REVOKED, 12_000, "merchant_demo_001", 3)

    assert follow_up["subject"].startswith("Reminder:")
    assert "following up on our earlier message" in follow_up["body"]
    assert follow_up != initial


def test_successful_payment_marks_the_sequence_recovered():
    recovered = SimpleNamespace(
        action_type=ActionType.RETRY,
        status=ActionStatus.SUCCEEDED,
        scheduled_at=datetime.now(timezone.utc),
        executed_at=datetime.now(timezone.utc),
        outcome={"status": "captured"},
    )

    assert _has_recovered([recovered]) is True

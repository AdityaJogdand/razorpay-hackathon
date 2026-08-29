import uuid
from datetime import datetime

from sqlalchemy import (
    String, Integer, BigInteger, Boolean, DateTime, Text, JSON,
    ForeignKey, Index, UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.dialects.postgresql import UUID, ENUM

from backend.core.database import Base
from backend.models.enums import (
    FailureClass, ActionType, ActionStatus, InstrumentType, LedgerEventType,
)


class FailureEvent(Base):
    __tablename__ = "failure_events"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    merchant_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    gateway_event_id: Mapped[str] = mapped_column(String(128), nullable=False)
    transaction_id: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    subscription_id: Mapped[str] = mapped_column(String(128), nullable=True)
    customer_id: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    customer_email: Mapped[str] = mapped_column(String(256), nullable=True)

    instrument_type: Mapped[InstrumentType] = mapped_column(
        ENUM(InstrumentType, name="instrument_type", create_type=True), nullable=False
    )
    instrument_token: Mapped[str] = mapped_column(String(256), nullable=False)

    raw_error_code: Mapped[str] = mapped_column(String(64), nullable=False)
    raw_error_description: Mapped[str] = mapped_column(Text, nullable=True)
    normalized_code: Mapped[str] = mapped_column(String(64), nullable=False)

    failure_class: Mapped[FailureClass] = mapped_column(
        ENUM(FailureClass, name="failure_class", create_type=True), nullable=True
    )
    classification_source: Mapped[str] = mapped_column(String(32), nullable=True)  # "RULES" or "LLM"
    classification_confidence: Mapped[float] = mapped_column(nullable=True)

    amount_paise: Mapped[int] = mapped_column(BigInteger, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), default="INR")

    failed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    ingested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)

    recovery_plan: Mapped["RecoveryPlan"] = relationship(back_populates="failure_event", uselist=False)
    actions: Mapped[list["Action"]] = relationship(back_populates="failure_event")

    __table_args__ = (
        UniqueConstraint("merchant_id", "gateway_event_id", name="uq_merchant_gateway_event"),
        Index("ix_failure_class", "failure_class"),
    )


class RecoveryPlan(Base):
    __tablename__ = "recovery_plans"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    failure_event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("failure_events.id"), nullable=False, unique=True
    )
    merchant_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    config_version: Mapped[int] = mapped_column(Integer, nullable=False)
    policy_version: Mapped[str] = mapped_column(String(32), nullable=False)

    plan_data: Mapped[dict] = mapped_column(JSON, nullable=False)  # immutable snapshot of planned actions
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)

    failure_event: Mapped["FailureEvent"] = relationship(back_populates="recovery_plan")


class Action(Base):
    __tablename__ = "actions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    failure_event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("failure_events.id"), nullable=False
    )
    recovery_plan_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("recovery_plans.id"), nullable=False
    )
    merchant_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)

    action_type: Mapped[ActionType] = mapped_column(
        ENUM(ActionType, name="action_type", create_type=True), nullable=False
    )
    status: Mapped[ActionStatus] = mapped_column(
        ENUM(ActionStatus, name="action_status", create_type=True), nullable=False, default=ActionStatus.SCHEDULED
    )
    idempotency_key: Mapped[str] = mapped_column(String(256), nullable=False, unique=True)

    scheduled_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    executed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=True)
    outcome: Mapped[dict] = mapped_column(JSON, nullable=True)

    retry_number: Mapped[int] = mapped_column(Integer, nullable=True)
    estimated_success_prob: Mapped[float] = mapped_column(nullable=True)
    estimated_uplift: Mapped[float] = mapped_column(nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)

    failure_event: Mapped["FailureEvent"] = relationship(back_populates="actions")

    __table_args__ = (
        Index("ix_action_scheduled", "scheduled_at"),
        Index("ix_action_status", "status"),
    )


class Suppression(Base):
    __tablename__ = "suppressions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    failure_event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("failure_events.id"), nullable=False
    )
    merchant_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)

    action_type: Mapped[ActionType] = mapped_column(
        ENUM(ActionType, name="action_type", create_type=True), nullable=False
    )
    rule_name: Mapped[str] = mapped_column(String(128), nullable=False)
    rule_version: Mapped[int] = mapped_column(Integer, nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)


class AuditLedger(Base):
    __tablename__ = "audit_ledger"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    merchant_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    event_type: Mapped[LedgerEventType] = mapped_column(
        ENUM(LedgerEventType, name="ledger_event_type", create_type=True), nullable=False
    )
    entity_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    entity_type: Mapped[str] = mapped_column(String(64), nullable=False)

    data: Mapped[dict] = mapped_column(JSON, nullable=False)
    previous_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    entry_hash: Mapped[str] = mapped_column(String(64), nullable=False)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)

    __table_args__ = (
        Index("ix_ledger_entity", "entity_type", "entity_id"),
        Index("ix_ledger_created", "created_at"),
    )


class ConfigVersion(Base):
    __tablename__ = "config_versions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    merchant_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False)

    max_retries: Mapped[int] = mapped_column(Integer, default=3)
    retry_window_hours: Mapped[int] = mapped_column(Integer, default=72)
    max_contacts: Mapped[int] = mapped_column(Integer, default=3)
    contact_cooldown_hours: Mapped[int] = mapped_column(Integer, default=24)
    uplift_threshold: Mapped[float] = mapped_column(default=0.05)
    confidence_threshold: Mapped[float] = mapped_column(default=0.7)
    expire_after_days: Mapped[int] = mapped_column(Integer, default=7)
    kill_switch: Mapped[bool] = mapped_column(Boolean, default=False)

    policy_data: Mapped[dict] = mapped_column(JSON, nullable=True)  # additional policy params

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    __table_args__ = (
        UniqueConstraint("merchant_id", "version", name="uq_merchant_config_version"),
    )

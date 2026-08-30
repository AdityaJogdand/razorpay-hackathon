"""persist human exception resolutions and recovery impact snapshots

Revision ID: b8e3f2a9c4d1
Revises: 67d3c1f9c6a2
Create Date: 2026-08-30
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "b8e3f2a9c4d1"
down_revision: Union[str, None] = "67d3c1f9c6a2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "exception_resolutions",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("failure_event_id", sa.UUID(), nullable=False),
        sa.Column("merchant_id", sa.String(length=64), nullable=False),
        sa.Column("resolution", sa.String(length=32), nullable=False),
        sa.Column("resolved_by", sa.String(length=128), nullable=False),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["failure_event_id"], ["failure_events.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("failure_event_id"),
    )
    op.create_index("ix_exception_resolutions_merchant_id", "exception_resolutions", ["merchant_id"], unique=False)
    op.create_index("ix_exception_resolution_resolved_at", "exception_resolutions", ["resolved_at"], unique=False)

    op.create_table(
        "recovery_impact_evaluations",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("merchant_id", sa.String(length=64), nullable=False),
        sa.Column("method", sa.String(length=16), nullable=False),
        sa.Column("split", sa.String(length=16), nullable=False),
        sa.Column("n_transactions", sa.Integer(), nullable=False),
        sa.Column("result_data", sa.JSON(), nullable=False),
        sa.Column("evaluated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_recovery_impact_evaluations_merchant_id", "recovery_impact_evaluations", ["merchant_id"], unique=False)
    op.create_index("ix_recovery_impact_evaluated_at", "recovery_impact_evaluations", ["evaluated_at"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_recovery_impact_evaluated_at", table_name="recovery_impact_evaluations")
    op.drop_index("ix_recovery_impact_evaluations_merchant_id", table_name="recovery_impact_evaluations")
    op.drop_table("recovery_impact_evaluations")
    op.drop_index("ix_exception_resolution_resolved_at", table_name="exception_resolutions")
    op.drop_index("ix_exception_resolutions_merchant_id", table_name="exception_resolutions")
    op.drop_table("exception_resolutions")

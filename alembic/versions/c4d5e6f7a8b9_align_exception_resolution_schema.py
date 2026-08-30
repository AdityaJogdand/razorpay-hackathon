"""align exception resolution table with the human-review API

Revision ID: c4d5e6f7a8b9
Revises: b8e3f2a9c4d1
Create Date: 2026-08-30
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c4d5e6f7a8b9"
down_revision: Union[str, None] = "b8e3f2a9c4d1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # The original migration used `resolution`; the application stores the
    # human decision as `resolution_type`. Renaming retains any existing data.
    op.alter_column(
        "exception_resolutions",
        "resolution",
        new_column_name="resolution_type",
        existing_type=sa.String(length=32),
        existing_nullable=False,
    )
    op.add_column("exception_resolutions", sa.Column("notes", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("exception_resolutions", "notes")
    op.alter_column(
        "exception_resolutions",
        "resolution_type",
        new_column_name="resolution",
        existing_type=sa.String(length=32),
        existing_nullable=False,
    )

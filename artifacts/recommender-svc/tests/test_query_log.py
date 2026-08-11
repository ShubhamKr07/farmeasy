"""
Task 5 — Repair recommender user identity and audit logging.

`lib/db/src/schema/index.ts:532-547` defines `recommender_queriesTable` with a
column named `user_id` (uuid("user_id")) — the live Postgres column is
`user_id`, NOT `clerk_user_id`. But `app/query_log.py`'s INSERT statement
referenced a column named `clerk_user_id`, which does not exist in the real
schema — a leftover from the Clerk→Supabase Auth migration that was never
renamed. The audit-log INSERT would fail with a Postgres
`column "clerk_user_id" does not exist` error against the real schema.

These tests lock the migrated contract: the generated INSERT must target the
real `user_id` column and pass a UUID, never the legacy `clerk_user_id`.
"""

import asyncio
import uuid
from unittest.mock import AsyncMock

import pytest


def _bootstrap_env(monkeypatch):
    """Settings() requires these at import time — set before importing app.db."""
    monkeypatch.setenv("DATABASE_URL", "postgresql://user:pw@host:5432/db")
    monkeypatch.setenv("GEMINI_API_KEY", "test")
    monkeypatch.setenv("INTERNAL_API_KEY", "test")


def test_log_query_insert_targets_user_id_column(monkeypatch):
    """Generated INSERT must reference `user_id`, never `clerk_user_id`."""
    _bootstrap_env(monkeypatch)
    from app import query_log

    pool = AsyncMock()
    pool.execute = AsyncMock(return_value=None)

    async def fake_get_pool():
        return pool

    monkeypatch.setattr(query_log, "get_pool", fake_get_pool)

    user_id = uuid.uuid4()
    asyncio.run(
        query_log.log_query(
            user_id,
            "What is my yield this week?",
            "Total yield this week: 12 kg.",
            [{"title": "t", "url": "u", "similarity": 0.9}],
            None,
        )
    )

    pool.execute.assert_awaited_once()
    call = pool.execute.await_args
    sql = call.args[0]

    assert "user_id" in sql, f"INSERT must reference the real user_id column; got:\n{sql}"
    assert "clerk_user_id" not in sql, (
        f"INSERT must not reference the legacy clerk_user_id column; got:\n{sql}"
    )
    # The first bind parameter ($1) is the user_id value, passed positionally.
    assert call.args[1] == user_id


def test_recommend_request_user_id_is_uuid():
    """Contract: RecommendRequest.user_id is a UUID (migrated identity)."""
    from pydantic import ValidationError

    from app.models import RecommendRequest

    valid_uuid = uuid.uuid4()
    req = RecommendRequest(
        user_id=valid_uuid, question="What is my yield this week?", org_id=1, facility_id=1
    )
    assert req.user_id == valid_uuid
    assert not hasattr(req, "clerk_user_id"), "legacy clerk_user_id field must be gone"

    # A bare string (the legacy Clerk identity shape) must be rejected —
    # the column is a Postgres uuid, so the contract is a UUID, not str.
    with pytest.raises(ValidationError):
        RecommendRequest(user_id="not-a-uuid", question="x", org_id=1, facility_id=1)

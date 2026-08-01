import json
from datetime import datetime
from decimal import Decimal
from uuid import UUID
from app.db import get_pool


def _json_default(obj):
    if isinstance(obj, Decimal):
        return float(obj)
    if isinstance(obj, datetime):
        return obj.isoformat()
    raise TypeError(f"not JSON serializable: {obj!r}")


async def log_query(
    user_id: UUID,
    question: str,
    answer: str,
    sources: list[dict],
    farm_context: dict | None,
) -> None:
    """Audit trail for recommender_queries — also backs a future "recent questions" UI."""
    pool = await get_pool()
    await pool.execute(
        """
        INSERT INTO recommender_queries
            (user_id, question, answer, sources, farm_context_used)
        VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
        """,
        user_id,
        question,
        answer,
        json.dumps(sources, default=_json_default),
        json.dumps(farm_context, default=_json_default) if farm_context else None,
    )

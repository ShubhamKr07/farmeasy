from uuid import UUID

from pydantic import BaseModel, Field


class RecommendRequest(BaseModel):
    user_id: UUID
    question: str = Field(min_length=1, max_length=2000)
    # Dashboard snapshot text, attached by api-server when the question
    # mentions operational keywords (yield, cycles, bad trays, ...) — this
    # service's own crop/seed-name grounding can't answer "what's my yield
    # this week" on its own.
    ops_context: str | None = None


class Source(BaseModel):
    title: str | None = None
    url: str
    similarity: float


class RecommendResponse(BaseModel):
    answer: str
    sources: list[Source]
    cache_hit: bool

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
    # MT-M2 task #5: the querying user's tenant, sent by api-server's
    # recommend.ts from req.tenant (resolved + re-validated per request by
    # requireTenantContext — never trusted from the client directly). Used to
    # set the app.org_id/app.facility_id GUCs (db.py's tenant-scope helper)
    # before farm_context.py's reads, so the recommender's own non-BYPASSRLS
    # farmsmart_recommender role is scoped by the existing role-agnostic RLS
    # policies (00007/00022) to this tenant's own data + global/system
    # reference — never cross-tenant.
    org_id: int
    facility_id: int


class Source(BaseModel):
    title: str | None = None
    url: str
    similarity: float


class RecommendResponse(BaseModel):
    answer: str
    sources: list[Source]
    cache_hit: bool

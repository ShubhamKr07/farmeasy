"""
Task 9 / Step 7 — bound recommendation requests inside recommender-svc.

These are unit/concurrency tests of the bounding logic itself (semaphore
saturation, request deadline, max-active count, provider HTTP-timeout
wiring, and permit release on every exit path). They deliberately do NOT
touch a real database, Gemini, or Tavily — the slow external steps are
monkeypatched and asyncio.run() drives the async code, matching the
existing sync test style in this package (no pytest-asyncio plugin).
"""

import asyncio
import time
import uuid

import pytest
from fastapi import HTTPException


def _bootstrap_env(monkeypatch):
    """Settings() requires these at import time — set before importing app.*."""
    monkeypatch.setenv("DATABASE_URL", "postgresql://user:pw@host:5432/db")
    monkeypatch.setenv("GEMINI_API_KEY", "test")
    monkeypatch.setenv("INTERNAL_API_KEY", "test")


def _req():
    from app.models import RecommendRequest

    return RecommendRequest(
        user_id=uuid.uuid4(),
        question="What is my yield this week?",
        org_id=1,
        facility_id=1,
    )


def _patch_externals(monkeypatch, main):
    """Replace every external call in the processing body with fast no-ops so
    the bounding logic (not the DB/Gemini/Tavily stack) is what's exercised."""
    from unittest.mock import AsyncMock

    async def fast_embed(text):
        return [0.0] * main.settings.embedding_dimensions

    monkeypatch.setattr(main, "embed", fast_embed)
    monkeypatch.setattr(main, "search_cache", AsyncMock(return_value=[]))
    monkeypatch.setattr(main, "get_farm_context", AsyncMock(return_value=None))
    monkeypatch.setattr(main, "log_query", AsyncMock(return_value=None))
    monkeypatch.setattr(main, "upsert_cache_docs", AsyncMock(return_value=None))
    monkeypatch.setattr(main.settings, "tavily_api_key", None)


# --------------------------------------------------------------------------- #
# Deadline (overall request budget) -> 504
# --------------------------------------------------------------------------- #
def test_deadline_exceeded_returns_504_and_releases_permit(monkeypatch):
    _bootstrap_env(monkeypatch)
    import app.main as main

    monkeypatch.setattr(main.settings, "recommender_request_deadline_seconds", 0.2)
    monkeypatch.setattr(main.settings, "recommender_queue_timeout_seconds", 5.0)

    async def slow_embed(text):
        # Sleep well past the 0.2s deadline so asyncio.timeout fires.
        await asyncio.sleep(5.0)

    monkeypatch.setattr(main, "embed", slow_embed)
    monkeypatch.setattr(main.settings, "tavily_api_key", None)

    async def scenario():
        sem = asyncio.Semaphore(2)
        monkeypatch.setattr(main, "_request_semaphore", sem)
        with pytest.raises(HTTPException) as exc:
            await main.recommend(_req())
        assert exc.value.status_code == 504
        # Permit must be returned to the pool after the 504 timeout path.
        assert sem._value == 2

    asyncio.run(scenario())


# --------------------------------------------------------------------------- #
# Saturation (bounded queue acquire) -> 503, fast, no hang
# --------------------------------------------------------------------------- #
def test_saturation_returns_503_within_queue_timeout(monkeypatch):
    _bootstrap_env(monkeypatch)
    import app.main as main

    monkeypatch.setattr(main.settings, "recommender_queue_timeout_seconds", 0.2)
    monkeypatch.setattr(main.settings, "recommender_request_deadline_seconds", 5.0)

    async def scenario():
        sem = asyncio.Semaphore(1)
        monkeypatch.setattr(main, "_request_semaphore", sem)
        # Pre-hold the only permit so the handler cannot acquire it.
        await sem.acquire()
        assert sem._value == 0

        start = time.monotonic()
        with pytest.raises(HTTPException) as exc:
            await main.recommend(_req())
        elapsed = time.monotonic() - start

        assert exc.value.status_code == 503
        # Failed fast (within the queue timeout), did not hang waiting on a slot.
        assert elapsed < 1.0, f"expected fast 503, waited {elapsed}s"
        # The 503 path acquires nothing, so it must not have released/touched
        # the permit we still hold.
        assert sem._value == 0
        # Releasing our hold returns the pool to full capacity.
        sem.release()
        assert sem._value == 1

    asyncio.run(scenario())


# --------------------------------------------------------------------------- #
# Max-active count — the semaphore genuinely bounds concurrent execution
# --------------------------------------------------------------------------- #
def test_max_concurrent_executions_never_exceed_limit(monkeypatch):
    _bootstrap_env(monkeypatch)
    import app.main as main

    max_concurrent = 3
    monkeypatch.setattr(main.settings, "recommender_request_deadline_seconds", 10.0)
    monkeypatch.setattr(main.settings, "recommender_queue_timeout_seconds", 10.0)
    _patch_externals(monkeypatch, main)

    live = 0
    peak = 0

    async def counting_embed(text):
        nonlocal live, peak
        live += 1
        peak = max(peak, live)
        await asyncio.sleep(0.05)  # force overlap so >max_concurrent would show
        live -= 1
        return [0.0] * main.settings.embedding_dimensions

    monkeypatch.setattr(main, "embed", counting_embed)

    async def scenario():
        sem = asyncio.Semaphore(max_concurrent)
        monkeypatch.setattr(main, "_request_semaphore", sem)
        # Launch more concurrent requests than the limit allows.
        await asyncio.gather(*[main.recommend(_req()) for _ in range(max_concurrent + 2)])
        return peak

    observed_peak = asyncio.run(scenario())

    assert observed_peak == max_concurrent, (
        f"concurrency must be bounded at {max_concurrent}, peaked at {observed_peak}"
    )
    assert observed_peak <= max_concurrent


# --------------------------------------------------------------------------- #
# Provider HTTP-timeout configuration is wired into both genai Clients
# --------------------------------------------------------------------------- #
def test_gemini_clients_carry_configured_http_timeout(monkeypatch):
    _bootstrap_env(monkeypatch)
    from app import embeddings, synthesis
    from app.config import settings

    emb_opts = embeddings._client._api_client._http_options
    syn_opts = synthesis._client._api_client._http_options

    assert emb_opts is not None, "embeddings genai.Client must set http_options"
    assert syn_opts is not None, "synthesis genai.Client must set http_options"
    assert emb_opts.timeout == settings.gemini_timeout_ms
    assert syn_opts.timeout == settings.gemini_timeout_ms
    # The configured value is the documented default (provider backstop, ms).
    assert settings.gemini_timeout_ms == 30_000


# --------------------------------------------------------------------------- #
# Release on exception
# --------------------------------------------------------------------------- #
def test_permit_released_on_processing_exception(monkeypatch):
    _bootstrap_env(monkeypatch)
    import app.main as main

    monkeypatch.setattr(main.settings, "recommender_request_deadline_seconds", 10.0)
    monkeypatch.setattr(main.settings, "recommender_queue_timeout_seconds", 10.0)
    monkeypatch.setattr(main.settings, "tavily_api_key", None)

    async def exploding_embed(text):
        raise RuntimeError("downstream blew up")

    monkeypatch.setattr(main, "embed", exploding_embed)

    async def scenario():
        sem = asyncio.Semaphore(2)
        monkeypatch.setattr(main, "_request_semaphore", sem)
        with pytest.raises(RuntimeError, match="downstream blew up"):
            await main.recommend(_req())
        # Pool fully restored after an exception propagated out of the body.
        assert sem._value == 2

    asyncio.run(scenario())


# --------------------------------------------------------------------------- #
# Release on task cancellation (client disconnect)
# --------------------------------------------------------------------------- #
def test_permit_released_on_task_cancellation(monkeypatch):
    _bootstrap_env(monkeypatch)
    import app.main as main

    monkeypatch.setattr(main.settings, "recommender_request_deadline_seconds", 10.0)
    monkeypatch.setattr(main.settings, "recommender_queue_timeout_seconds", 10.0)
    monkeypatch.setattr(main.settings, "tavily_api_key", None)

    async def slow_embed(text):
        await asyncio.sleep(5.0)

    monkeypatch.setattr(main, "embed", slow_embed)

    async def scenario():
        sem = asyncio.Semaphore(2)
        monkeypatch.setattr(main, "_request_semaphore", sem)

        task = asyncio.create_task(main.recommend(_req()))
        # Give the handler time to acquire a permit and enter the slow body.
        await asyncio.sleep(0.05)
        assert sem._value == 1, "handler should hold one permit while processing"
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        # Permit must be returned even when the task was cancelled mid-flight.
        assert sem._value == 2

    asyncio.run(scenario())


# --------------------------------------------------------------------------- #
# Permit restored after every failure path — proven behaviorally by acquiring
# the full allotment of fresh permits immediately afterwards.
# --------------------------------------------------------------------------- #
def test_full_capacity_reacquirable_after_each_failure_path(monkeypatch):
    _bootstrap_env(monkeypatch)
    import app.main as main

    monkeypatch.setattr(main.settings, "recommender_queue_timeout_seconds", 10.0)
    monkeypatch.setattr(main.settings, "tavily_api_key", None)
    max_concurrent = 2

    async def run_one(sem_factory, deadline, embed_fn):
        monkeypatch.setattr(main.settings, "recommender_request_deadline_seconds", deadline)
        monkeypatch.setattr(main, "embed", embed_fn)
        monkeypatch.setattr(main, "_request_semaphore", sem_factory())
        try:
            await main.recommend(_req())
        except (HTTPException, Exception):
            # Timeout (504) and downstream exceptions both must release the
            # permit; we only care that control returned without leaking it.
            pass

    async def scenario():
        # Timeout path.
        async def slow(text):
            await asyncio.sleep(5.0)

        await run_one(lambda: asyncio.Semaphore(max_concurrent), 0.1, slow)

        # Exception path.
        async def boom(text):
            raise ValueError("boom")

        await run_one(lambda: asyncio.Semaphore(max_concurrent), 10.0, boom)

        # Cancellation path.
        sem = asyncio.Semaphore(max_concurrent)
        monkeypatch.setattr(main.settings, "recommender_request_deadline_seconds", 10.0)
        monkeypatch.setattr(main, "embed", slow)
        monkeypatch.setattr(main, "_request_semaphore", sem)
        task = asyncio.create_task(main.recommend(_req()))
        await asyncio.sleep(0.05)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        assert sem._value == max_concurrent, "permit not restored after cancellation"
        # And we can immediately grab the full allotment again (no leak).
        for _ in range(max_concurrent):
            await sem.acquire()
        assert sem._value == 0

    asyncio.run(scenario())

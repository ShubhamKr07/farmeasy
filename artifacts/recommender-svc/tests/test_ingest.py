import pytest


def test_unpooled_database_url_uses_explicit_direct_var(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://postgres.abc:pw@aws-0-us-west-1.pooler.supabase.com:6543/postgres")
    monkeypatch.setenv("DATABASE_URL_DIRECT", "postgresql://postgres.abc:pw@aws-0-us-west-1.pooler.supabase.com:5432/postgres")
    monkeypatch.setenv("GEMINI_API_KEY", "test")
    monkeypatch.setenv("INTERNAL_API_KEY", "test")

    from app.config import Settings

    settings = Settings()

    from app.ingest import _unpooled_database_url

    assert _unpooled_database_url(settings) == settings.database_url_direct


def test_unpooled_database_url_raises_when_direct_var_missing(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://postgres.abc:pw@aws-0-us-west-1.pooler.supabase.com:6543/postgres")
    monkeypatch.delenv("DATABASE_URL_DIRECT", raising=False)
    monkeypatch.setenv("GEMINI_API_KEY", "test")
    monkeypatch.setenv("INTERNAL_API_KEY", "test")

    from app.config import Settings

    settings = Settings()

    from app.ingest import _unpooled_database_url

    with pytest.raises(ValueError, match="DATABASE_URL_DIRECT"):
        _unpooled_database_url(settings)

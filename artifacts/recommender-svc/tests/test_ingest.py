import pytest


def test_unpooled_database_url_uses_explicit_direct_var(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://postgres.abc:pw@aws-0-us-west-1.pooler.supabase.com:6543/postgres")
    monkeypatch.setenv("DATABASE_URL_DIRECT", "postgresql://postgres.abc:pw@aws-0-us-west-1.pooler.supabase.com:5432/postgres")
    monkeypatch.setenv("GEMINI_API_KEY", "test")
    monkeypatch.setenv("INTERNAL_API_KEY", "test")

    from app.config import Settings

    settings = Settings()

    from app.ingest import _unpooled_database_url

    # Base of the returned URL is DATABASE_URL_DIRECT (the session-pooler
    # string), NOT the transaction-pooler DATABASE_URL — this is the core
    # contract this test locks. Task 10 additionally appends CA-pinned TLS
    # params (sslmode=verify-full&sslrootcert=...) for psycopg2, so the URL
    # is no longer byte-identical to database_url_direct.
    url = _unpooled_database_url(settings)
    assert url.startswith(settings.database_url_direct)
    assert "sslmode=verify-full" in url
    assert "sslrootcert=/tmp/farmsmart-db-ca.pem" in url


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

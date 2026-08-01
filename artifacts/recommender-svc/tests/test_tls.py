"""
Task 10 (recommender-svc, Python side) — CA-pinned TLS for the DB connection.

app/tls.py wires CA-pinned TLS (the shared "Supabase Root 2021 CA" via
DATABASE_CA_CERT) into BOTH database clients in this service:

* asyncpg (app/db.py) consumes an ssl.SSLContext built from ``cadata``;
* dlt/psycopg2 (app/ingest.py) needs the CA on disk as a file path, so the
  same PEM is written to /tmp/farmsmart-db-ca.pem (mode 0600).

These tests lock the brief's Step 1 (recommender-specific) contract:

* missing production CA fails clearly (fail-closed, no silent insecure
  fallback — same posture as the Node side's buildSslConfig);
* an invalid/garbage CA surfaces as a clean error rather than a confusing
  low-level TLS handshake failure at connection time;
* the file-permission (exactly 0600) and cleanup behavior is correct,
  including cleanup tolerating an already-absent file.

Sync test functions + monkeypatch, matching this package's existing style
(test_ingest.py / test_query_log.py / test_request_limits.py) — no
pytest-asyncio plugin, tls.py's functions are entirely sync (SSLContext
construction + file I/O).

NOTE: the tls functions default to the module-level `settings` singleton
(bound at app.config import time), which depends on test import order. To
keep these tests hermetic and deterministic we always pass an EXPLICIT
Settings instance (built per test) into the functions — the same pattern
test_ingest.py uses for _unpooled_database_url(settings).
"""

import os
import ssl
import subprocess

import pytest


def _bootstrap_env(monkeypatch):
    """Settings()/the app.config singleton require these at import time —
    set before importing app.config / app.tls. DATABASE_CA_CERT is NOT set
    here; every test supplies the CA value explicitly via _settings()."""
    monkeypatch.setenv("DATABASE_URL", "postgresql://user:pw@host:5432/db")
    monkeypatch.setenv("GEMINI_API_KEY", "test")
    monkeypatch.setenv("INTERNAL_API_KEY", "test")
    monkeypatch.delenv("DATABASE_CA_CERT", raising=False)


def _settings(ca_cert=None):
    """A hermetic Settings with the required fields pre-filled and the CA
    value controlled explicitly (overrides any env)."""
    from app.config import Settings

    return Settings(  # type: ignore[call-arg]
        database_url="postgresql://user:pw@host:5432/db",
        database_url_direct="postgresql://user:pw@host:5432/db",
        gemini_api_key="test",
        internal_api_key="test",
        database_ca_cert=ca_cert,
    )


@pytest.fixture(scope="module")
def valid_ca_pem() -> str:
    """A real, parseable self-signed X.509 PEM — enough for
    ssl.create_default_context to load into its trust store without raising.
    It does not need to chain to a real root, only to be well-formed. Generated
    via the system openssl (ubiquitous on macOS + CI)."""
    proc = subprocess.run(
        [
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
            "-keyout", "/dev/null", "-days", "1", "-subj", "/CN=task10-test-ca",
        ],
        check=True,
        capture_output=True,
    )
    pem = proc.stdout.decode()
    assert "BEGIN CERTIFICATE" in pem, "openssl produced no cert PEM"
    return pem


# --------------------------------------------------------------------------- #
# Missing CA — fail-closed, no silent insecure fallback
# --------------------------------------------------------------------------- #
def test_missing_ca_raises_clearly_in_build_context(monkeypatch):
    _bootstrap_env(monkeypatch)
    from app.tls import build_asyncpg_ssl_context

    with pytest.raises(RuntimeError, match="DATABASE_CA_CERT"):
        build_asyncpg_ssl_context(_settings(ca_cert=None))


def test_missing_ca_raises_clearly_in_write_file(monkeypatch, tmp_path):
    _bootstrap_env(monkeypatch)
    from app.tls import write_ca_cert_file

    path = str(tmp_path / "ca.pem")
    with pytest.raises(RuntimeError, match="DATABASE_CA_CERT"):
        write_ca_cert_file(_settings(ca_cert=None), path=path)

    # Fail-closed also means: no file was created on the insecure path.
    assert not os.path.exists(path)


# --------------------------------------------------------------------------- #
# Invalid / garbage CA — surfaces as a clean error, not a confusing handshake
# --------------------------------------------------------------------------- #
def test_invalid_ca_surfaces_cleanly_in_build_context(monkeypatch):
    _bootstrap_env(monkeypatch)
    from app.tls import build_asyncpg_ssl_context

    # ssl.create_default_context(cadata=...) raises on unparseable PEM; the
    # test proves that error surfaces at config time (clear, actionable)
    # rather than later as a low-level handshake error during a real query.
    with pytest.raises(ssl.SSLError):
        build_asyncpg_ssl_context(_settings(ca_cert="not a real certificate pem content"))


# --------------------------------------------------------------------------- #
# Valid CA — strict context (CERT_REQUIRED + check_hostname), no insecure flag
# --------------------------------------------------------------------------- #
def test_valid_ca_builds_strict_context(monkeypatch, valid_ca_pem):
    _bootstrap_env(monkeypatch)
    from app.tls import build_asyncpg_ssl_context

    ctx = build_asyncpg_ssl_context(_settings(ca_cert=valid_ca_pem))

    assert ctx.verify_mode == ssl.CERT_REQUIRED, (
        "context must require a verified server cert (not CERT_OPTIONAL/_NONE)"
    )
    assert ctx.check_hostname is True, (
        "context must verify the server hostname (Task 10 anti-MITM posture)"
    )


# --------------------------------------------------------------------------- #
# File write — exactly 0600, correct content, no insecure-permission window
# --------------------------------------------------------------------------- #
def test_write_ca_cert_file_creates_mode_0600_with_correct_content(monkeypatch, tmp_path, valid_ca_pem):
    _bootstrap_env(monkeypatch)
    from app.tls import write_ca_cert_file

    path = str(tmp_path / "farmsmart-db-ca.pem")
    returned = write_ca_cert_file(_settings(ca_cert=valid_ca_pem), path=path)

    assert returned == path
    assert os.path.exists(path)
    # Mode must be EXACTLY 0600 (owner read/write only) — no group/other bits.
    mode = os.stat(path).st_mode & 0o777
    assert mode == 0o600, f"CA cert file must be 0600, got {oct(mode)}"
    with open(path) as f:
        assert f.read() == valid_ca_pem, "file content must be the CA PEM verbatim"


def test_write_ca_cert_file_truncates_existing_file(monkeypatch, tmp_path, valid_ca_pem):
    # A pre-existing (e.g. stale) file must be overwritten, not appended.
    _bootstrap_env(monkeypatch)
    from app.tls import write_ca_cert_file

    path = str(tmp_path / "farmsmart-db-ca.pem")
    with open(path, "w") as f:
        f.write("STALE CONTENT THAT MUST BE GONE")

    write_ca_cert_file(_settings(ca_cert=valid_ca_pem), path=path)
    with open(path) as f:
        content = f.read()
    assert content == valid_ca_pem
    assert "STALE" not in content
    # Mode still exactly 0600 even though the file pre-existed.
    assert (os.stat(path).st_mode & 0o777) == 0o600


# --------------------------------------------------------------------------- #
# Cleanup — removes the file, and tolerates it already being absent
# --------------------------------------------------------------------------- #
def test_cleanup_removes_file(monkeypatch, tmp_path, valid_ca_pem):
    _bootstrap_env(monkeypatch)
    from app.tls import cleanup_ca_cert_file, write_ca_cert_file

    path = str(tmp_path / "farmsmart-db-ca.pem")
    write_ca_cert_file(_settings(ca_cert=valid_ca_pem), path=path)
    assert os.path.exists(path)

    cleanup_ca_cert_file(path=path)
    assert not os.path.exists(path), "cleanup must remove the CA cert file"


def test_cleanup_tolerates_already_absent_file(tmp_path):
    # A missing file (failed write, idempotent shutdown hook) must not raise.
    from app.tls import cleanup_ca_cert_file

    path = str(tmp_path / "never-written-ca.pem")
    assert not os.path.exists(path)

    cleanup_ca_cert_file(path=path)  # must not raise FileNotFoundError
    cleanup_ca_cert_file(path=path)  # idempotent: second call still safe
    assert not os.path.exists(path)


# --------------------------------------------------------------------------- #
# Ingest wiring — the dlt/psycopg2 URL carries sslmode=verify-full + sslrootcert
# --------------------------------------------------------------------------- #
def test_unpooled_database_url_appends_verify_full_ssl_params(monkeypatch):
    _bootstrap_env(monkeypatch)
    from app.ingest import _unpooled_database_url
    from app.tls import CA_CERT_PATH

    url = _unpooled_database_url(_settings(ca_cert="dummy-ca"))

    # The base DSN (no query params) gets a fresh "?" separator.
    assert url.startswith(
        "postgresql://user:pw@host:5432/db?sslmode=verify-full"
        f"&sslrootcert={CA_CERT_PATH}"
    ), url
    assert "sslmode=verify-full" in url, "dlt URL must require strict CA verification"
    assert f"sslrootcert={CA_CERT_PATH}" in url, (
        "dlt URL must point psycopg2 at the written CA file path"
    )


def test_unpooled_database_url_defensive_separator_when_params_present(monkeypatch):
    # If a future DSN already carries query params, we must join with "&" not "?".
    _bootstrap_env(monkeypatch)
    from app.ingest import _unpooled_database_url
    from app.config import Settings

    settings = Settings(  # type: ignore[call-arg]
        database_url="postgresql://user:pw@host:6543/db",
        database_url_direct="postgresql://postgres.abc:pw@h.supabase.com:5432/postgres?application_name=dlt",
        gemini_api_key="test",
        internal_api_key="test",
        database_ca_cert="dummy-ca",
    )
    url = _unpooled_database_url(settings)

    assert "application_name=dlt" in url
    assert url.count("?") == 1, "existing params joined with '&', no second '?'"
    assert "sslmode=verify-full" in url
    assert "sslrootcert=/tmp/farmsmart-db-ca.pem" in url

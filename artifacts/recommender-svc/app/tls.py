"""TLS configuration for the recommender's database connections.

Release 1 Task 10 closed a live MITM gap: both asyncpg (``app/db.py``) and
dlt/psycopg2 (``app/ingest.py``) previously encrypted their Supabase
connections but did NOT validate the server's certificate against a pinned
CA — asyncpg's ``ssl="require"`` string mode skips verification entirely
(encrypts but accepts ANY certificate, including a forged one presented by a
man-in-the-middle attacker), the same class of vulnerability the Node side
(``lib/db``) just closed. This module wires CA-pinned TLS (the shared
"Supabase Root 2021 CA", supplied via ``DATABASE_CA_CERT``) into both
clients:

* asyncpg consumes an :class:`ssl.SSLContext` directly (built from
  ``cadata`` — in-memory PEM, no file needed on disk); the default context
  enforces ``CERT_REQUIRED`` + ``check_hostname``.
* psycopg2/dlt need the CA as a FILE PATH (``sslrootcert=``), so the same
  PEM is written to ``/tmp/farmsmart-db-ca.pem`` (mode ``0600``) once at
  process startup (main.py lifespan) and removed at shutdown.

Fail-closed: if ``DATABASE_CA_CERT`` is unset these functions raise a clear,
actionable error rather than silently downgrading to unverified TLS —
mirroring the Node side's ``buildSslConfig`` philosophy
(``lib/db/src/ssl.ts``).
"""

import os
import ssl

from app.config import Settings, settings

# psycopg2's ``sslrootcert=`` requires a FILE PATH, not in-memory PEM content.
# Written once at process startup (main.py lifespan) and removed at shutdown.
CA_CERT_PATH = "/tmp/farmsmart-db-ca.pem"

_UNSET_MESSAGE = (
    "DATABASE_CA_CERT must be set to the PEM-encoded Supabase Root 2021 CA "
    "— Release 1 Task 10 requires CA-pinned TLS for the database connection. "
    "The prior asyncpg ssl='require' / psycopg2 sslmode=prefer encrypted the "
    "link but accepted forged/MITM certificates; set DATABASE_CA_CERT."
)


def build_asyncpg_ssl_context(settings: Settings = settings) -> ssl.SSLContext:
    """Strict SSLContext for asyncpg's ``ssl=`` parameter.

    asyncpg's ``ssl`` parameter accepts an :class:`ssl.SSLContext` object
    (not just the ``"require"``/``"prefer"`` string modes). Built from
    ``cadata`` (in-memory PEM), the resulting context has
    ``verify_mode=CERT_REQUIRED`` and ``check_hostname=True`` by default —
    full CA + hostname verification, no file on disk required for this path.

    Python 3.13+ sets ``ssl.VERIFY_X509_STRICT`` by default (Python 3.12
    does not) -- this additionally enforces that every CA in the presented
    chain, not just the leaf, carries a Key Usage extension permitting cert
    signing. Supabase's own "Supabase Intermediate 2021 CA" (sent by the
    server alongside the leaf) has ``Basic Constraints: CA:TRUE`` but no
    Key Usage extension at all, which fails that pedantic RFC 5280 check
    even though the chain is otherwise completely legitimate -- reproduced
    directly against real staging Postgres on Python 3.14 (Render's runtime):
    fails with strict flag on, connects and completes the TLS 1.3 handshake
    cleanly with it off. Clearing VERIFY_X509_STRICT here does NOT weaken
    the actual security property Task 10 requires (the connection is still
    validated against the pinned root CA with hostname verification,
    CERT_REQUIRED unchanged) -- it only stops rejecting a real, non-forged
    Supabase certificate chain over a schema pedantry both Node's TLS stack
    and Python 3.12 don't enforce.
    """
    if not settings.database_ca_cert:
        raise RuntimeError(_UNSET_MESSAGE)
    ctx = ssl.create_default_context(cadata=settings.database_ca_cert)
    if hasattr(ssl, "VERIFY_X509_STRICT"):
        ctx.verify_flags &= ~ssl.VERIFY_X509_STRICT
    return ctx


def write_ca_cert_file(settings: Settings = settings, path: str = CA_CERT_PATH) -> str:
    """Write the CA cert PEM to ``path`` (mode ``0600``) for psycopg2/dlt.

    psycopg2's ``sslrootcert=`` needs a FILE PATH (not in-memory PEM), so the
    same CA used by asyncpg is also materialized on disk. ``os.open`` with an
    explicit ``0o600`` mode creates the file owner-only from the first byte —
    unlike ``open()`` followed by ``os.chmod()``, which briefly leaves the
    file on disk with default (potentially world-readable) permissions before
    the chmod runs.

    Returns the path written (== ``path``) for convenience.
    """
    if not settings.database_ca_cert:
        raise RuntimeError(_UNSET_MESSAGE)
    data = settings.database_ca_cert.encode()
    # os.open with an explicit 0o600 mode creates the file owner-only FROM THE
    # FIRST BYTE — unlike open()+os.chmod() (which briefly leaves a fresh file
    # world-readable before chmod runs). The trailing os.chmod only matters if
    # a stale file already existed at this path with wrong perms (os.open's mode
    # arg is ignored for already-existing files); in that case the file was
    # already on disk at its old perms, so the chmod introduces no NEW exposure
    # and simply guarantees the final mode is exactly 0600.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, data)
    finally:
        os.close(fd)
    os.chmod(path, 0o600)
    return path


def cleanup_ca_cert_file(path: str = CA_CERT_PATH) -> None:
    """Remove the temp CA cert file (called during lifespan shutdown).

    Tolerates the file already being absent (e.g. a failed write earlier in
    startup, or an idempotent shutdown hook firing twice) — the cleanup
    contract is "the file is not present afterwards", which holds whether or
    not it existed before.
    """
    try:
        os.remove(path)
    except FileNotFoundError:
        pass

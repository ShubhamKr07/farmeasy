import { describe, test, before, after, mock } from "node:test";
import { deepStrictEqual, rejects, strictEqual } from "node:assert";

/**
 * Task 11 Step 1: signMediaReferences behavior.
 *
 * signMediaReferences is the READ-side signing service. Every API response
 * that returns stored photo references (manual-checks, bad-tray entries,
 * `facility_logs.data.photoUrls`) runs them through here so a client always
 * receives fetchable HTTPS URLs — regardless of whether each individual row
 * was written before or after the key-migration deploy.
 *
 * During the Task 11 compatibility window a single array can contain BOTH:
 *   - Legacy full public Supabase URLs (pre-deploy records) — absolute
 *     `http(s)://` — pass through UNCHANGED (still directly usable while the
 *     bucket stays public; re-signing a public URL would be pointless).
 *   - New bucket-relative keys (`media/<file>`) — converted to real signed
 *     URLs via `supabaseAdmin.storage.from('media').createSignedUrl`.
 *
 * No real Supabase connection is made: `supabaseAdmin.storage.from` is mocked
 * per-test. supabaseAuth.ts reads env vars at module load, so the modules are
 * imported DYNAMICALLY inside before() (after seeding syntactically-valid
 * dummy env, mirroring recommend.test.ts) — a static top-level import would
 * evaluate supabaseAuth.ts before the env is set and crash on
 * `process.env.SUPABASE_URL!.replace(...)`.
 */

const ENV_DEFAULTS = {
  DATABASE_URL: "postgres://dummy:dummy@localhost:5432/dummy",
  SUPABASE_URL: "https://dummy.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "dummy-service-role-key",
} as const;

const ENV_KEYS = Object.keys(ENV_DEFAULTS) as (keyof typeof ENV_DEFAULTS)[];
const savedEnv: Record<string, string | undefined> = {};

// Populated by before() via dynamic imports (after env is seeded).
let signMediaReferences: typeof import("../../services/mediaUrls")["signMediaReferences"];
let storage: (typeof import("../../middlewares/supabaseAuth"))["supabaseAdmin"]["storage"];

before(async () => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    if (process.env[k] === undefined) process.env[k] = ENV_DEFAULTS[k];
  }
  const auth = await import("../../middlewares/supabaseAuth");
  const svc = await import("../../services/mediaUrls");
  signMediaReferences = svc.signMediaReferences;
  storage = auth.supabaseAdmin.storage;
});

after(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/** Deterministic signed-URL string the mock returns for a key + expiry. */
function fakeSignedUrl(key: string, expiresIn: number): string {
  return `https://dummy.supabase.co/storage/v1/object/sign/${key}?token=fake&expires=${expiresIn}`;
}

/**
 * Signature the per-test `from()` mock uses to decide what createSignedUrl
 * returns for a given (key, expiresIn): success (signedUrl) or an error.
 */
type SignResult =
  | { signedUrl: string; error?: undefined }
  | { signedUrl?: undefined; error: { message: string } };

/**
 * Install a mock on `supabaseAdmin.storage.from` whose `createSignedUrl`
 * delegates to `sign(key, expiresIn)`. Returns a restore function. The mock
 * matches the real storage-js return shape (`{ data: { signedUrl, path },
 * error: null } | { data: null, error }`) so the service's destructuring
 * behaves exactly as in production.
 */
function mockStorageFrom(sign: (key: string, expiresIn: number) => SignResult): () => void {
  const fromMock = mock.method(
    storage,
    "from",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((): any => ({
      createSignedUrl: async (key: string, expiresIn: number) => {
        const r = sign(key, expiresIn);
        if (r.error) return { data: null, error: r.error };
        return { data: { signedUrl: r.signedUrl, path: key }, error: null };
      },
    })) as never,
  );
  return () => fromMock.mock.restore();
}

describe("signMediaReferences (Task 11 Step 1)", () => {
  test("preserves external (already-absolute) URLs unchanged — never signs them", async () => {
    // Legacy pre-deploy records stored full public Supabase URLs. These must
    // pass through verbatim so legacy photos stay readable during the compat
    // window. The mock THROWS if reached, proving createSignedUrl is never
    // called for an absolute URL.
    const restore = mockStorageFrom(() => {
      throw new Error("createSignedUrl must not be called for an absolute URL");
    });
    try {
      const external = [
        "https://dummy.supabase.co/storage/v1/object/public/media/old.jpg",
        "http://example.com/legacy.png",
      ];
      const out = await signMediaReferences(external);
      deepStrictEqual(out, external);
    } finally {
      restore();
    }
  });

  test("signs bucket-relative keys via createSignedUrl, forwarding the key + expiry", async () => {
    let signedKey: string | null = null;
    let signedExpires: number | null = null;
    const restore = mockStorageFrom((key, expiresIn) => {
      signedKey = key;
      signedExpires = expiresIn;
      return { signedUrl: fakeSignedUrl(key, expiresIn) };
    });
    try {
      const out = await signMediaReferences(["media/abc123.jpg"]);
      strictEqual(out.length, 1);
      strictEqual(out[0], fakeSignedUrl("media/abc123.jpg", 3600));
      // The key + expiry were forwarded to createSignedUrl verbatim.
      strictEqual(signedKey, "media/abc123.jpg");
      strictEqual(signedExpires, 3600);
    } finally {
      restore();
    }
  });

  test("honors a custom expiresInSeconds (default 3600 overridden)", async () => {
    let captured: number | null = null;
    const restore = mockStorageFrom((key, expiresIn) => {
      captured = expiresIn;
      return { signedUrl: fakeSignedUrl(key, expiresIn) };
    });
    try {
      await signMediaReferences(["media/abc.jpg"], 1800);
      strictEqual(captured, 1800);
    } finally {
      restore();
    }
  });

  test("preserves order across a mix of external URLs and bucket keys", async () => {
    // The exact shape a real record holds once new (key-storing) writes and
    // legacy (URL-storing) writes coexist: a mix of both in one array.
    // Output order MUST match input order so a client can map output→input by
    // index (the manual-checks/bad-trays photo rows rely on this).
    const restore = mockStorageFrom((key, expiresIn) => ({
      signedUrl: fakeSignedUrl(key, expiresIn),
    }));
    try {
      const input = [
        "https://dummy.supabase.co/storage/v1/object/public/media/legacy1.jpg", // external
        "media/new1.jpg", // key
        "media/new2.png", // key
        "https://cdn.example.com/external.jpeg", // external
        "media/new3.jpg", // key
      ];
      const out = await signMediaReferences(input);
      deepStrictEqual(out, [
        input[0], // external passed through
        fakeSignedUrl("media/new1.jpg", 3600),
        fakeSignedUrl("media/new2.png", 3600),
        input[3], // external passed through
        fakeSignedUrl("media/new3.jpg", 3600),
      ]);
    } finally {
      restore();
    }
  });

  test("fails the WHOLE response when createSignedUrl errors for any one reference", async () => {
    // Mirrors media.ts's existing storage-error → 502 convention: a partial
    // result (some signed, some not) is NEVER returned. If createSignedUrl
    // errors for ANY single reference, the call throws so the caller surfaces
    // a clean 502 rather than a half-signed array.
    const restore = mockStorageFrom((key) => {
      if (key === "media/broken.jpg") {
        return { error: { message: "object not found" } };
      }
      return { signedUrl: fakeSignedUrl(key, 3600) };
    });
    try {
      await rejects(
        signMediaReferences(["media/ok.jpg", "media/broken.jpg", "media/also-ok.jpg"]),
        /Failed to sign media reference "media\/broken\.jpg"/,
      );
    } finally {
      restore();
    }
  });

  test("fails when createSignedUrl returns null data with no signedUrl", async () => {
    // Defensive: the storage-js union can return { data: null, error } for an
    // unexpected empty/error body. Treat absence of signedUrl as failure too
    // — never silently emit an empty/undefined entry into the response.
    const restore = mockStorageFrom(() => ({ error: { message: "unexpected empty response" } }));
    try {
      await rejects(
        signMediaReferences(["media/empty.jpg"]),
        /Failed to sign media reference "media\/empty\.jpg"/,
      );
    } finally {
      restore();
    }
  });

  test("empty input → empty output (no storage calls)", async () => {
    const restore = mockStorageFrom(() => {
      throw new Error("createSignedUrl must not be called for an empty input");
    });
    try {
      const out = await signMediaReferences([]);
      deepStrictEqual(out, []);
    } finally {
      restore();
    }
  });
});

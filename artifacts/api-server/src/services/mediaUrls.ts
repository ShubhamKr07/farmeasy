import { supabaseAdmin } from "../middlewares/supabaseAuth";

/**
 * Name of the Supabase Storage bucket every media object lives in. Kept in
 * sync with the upload route's constant — both sides of Task 11 (store-under
 * `media/<file>` on upload, sign that same `media/<file>` key on read) agree
 * on this single bucket name.
 */
const MEDIA_BUCKET = "media";

/**
 * Absolute-URL detector. A stored photo reference is one of two shapes during
 * the Task 11 compatibility window:
 *   1. A legacy full public Supabase URL (records written BEFORE this deploy)
 *      — starts with `http://` or `https://` and is already directly
 *      fetchable while the bucket stays public. These pass through unchanged.
 *   2. A new bucket-relative key (records written AFTER this deploy), e.g.
 *      `media/a1b2c3d4.jpg`. These are signed on demand below.
 *
 * `String.prototype.startsWith` is used (case-sensitive) rather than a regex
 * because stored keys are server-generated and never start with a scheme;
 * only genuine external URLs ever match, and they're always lowercase.
 */
function isExternalUrl(ref: string): boolean {
  return ref.startsWith("http://") || ref.startsWith("https://");
}

/**
 * Convert a list of stored photo references into fetchable HTTPS URLs at the
 * API response boundary (Task 11 Step 2).
 *
 * Every API response that returns previously-stored photo references
 * (manual-checks, bad-tray entries, and `facility_logs.data.photoUrls`) runs
 * them through here so a client always receives immediately-usable URLs
 * regardless of whether the underlying row predates the key-migration deploy.
 *
 * Behavior:
 *   - Legacy absolute URLs (`http(s)://...`) pass through UNCHANGED. They're
 *     still directly usable while the storage bucket remains public during the
 *     compatibility window, and re-signing a public URL would be pointless.
 *   - Bucket-relative keys are converted to real signed URLs via
 *     `supabaseAdmin.storage.from('media').createSignedUrl(path, expiresInSeconds)`,
 *     defaulting to a 1-hour expiry.
 *   - Array ORDER IS PRESERVED: output[i] corresponds to input[i] so callers
 *     can map results back to their source references by index.
 *
 * On failure: if `createSignedUrl` returns an error or no `signedUrl` for ANY
 * single reference, the whole call THROWS. We never return a partially-signed
 * array (some signed, some not) — that would give a client a silently-broken
 * mix. Callers catch and surface a clean 502, mirroring media.ts's existing
 * `if (error) { ... 502 ... }` storage-error convention.
 */
export async function signMediaReferences(
  references: readonly string[],
  expiresInSeconds = 3600,
): Promise<string[]> {
  const out: string[] = [];
  for (const ref of references) {
    if (isExternalUrl(ref)) {
      out.push(ref);
      continue;
    }
    const { data, error } = await supabaseAdmin.storage
      .from(MEDIA_BUCKET)
      .createSignedUrl(ref, expiresInSeconds);
    if (error || !data?.signedUrl) {
      throw new Error(
        `Failed to sign media reference "${ref}": ${error?.message ?? "no signedUrl returned"}`,
      );
    }
    out.push(data.signedUrl);
  }
  return out;
}

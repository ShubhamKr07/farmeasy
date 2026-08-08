import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { requestAccess } from "@workspace/api-client-react";

/**
 * TEN-012 Task 11/12: Request-access capture form (flag-off waitlist).
 *
 * Rendered by `SignUpForm` (and its routing parent) when sign-up is closed:
 *   - `mode === "off"` (global flag off), OR
 *   - `mode === "allowlist"` and the typed email isn't on the allowlist.
 *
 * Posts `{ email, farmName }` to the PUBLIC endpoint
 * `POST /api/auth/request-access` (no bearer token) via the generated
 * `requestAccess` fetcher (Task 12 codegen). The server writes only the
 * `access_requests` row — it never creates an account/org/facility — and
 * replies `201 { ok: true }` on success, which the fetcher returns as a
 * parsed `RequestAccessResponse`. On a 4xx/5xx the fetcher throws the
 * `ApiError` (custom-fetch.ts), carrying `status` and the parsed `data`
 * body; we duck-type those (the class isn't re-exported, mirroring
 * `TeamSection.tsx`'s invite-error handling) to map 400 → per-field /
 * inline copy and everything else → a generic message.
 *
 * All validation/errors are INLINE (under the relevant field or below the
 * submit button), never a toast — matching the convention already in
 * SignUpForm (field text) and VerifyInterstitial (one-shot action status).
 * Backend re-validates everything; this client-side pass is just so an empty
 * submit doesn't waste a round-trip and shows the error in the right place.
 */

export interface RequestAccessFormProps {
  /** Email the user already typed into the AuthGate's shared email field, so
   * they don't retype it here. Local to this form once mounted — editing it
   * does not propagate back to the parent (sign-up is closed anyway). */
  defaultEmail?: string;
}

// Mirror the server's zod bounds (auth.ts: RequestAccessSchema).
const FARM_NAME_MAX = 120;

/**
 * The shape of the server's 400 body for request-access (auth.ts):
 * `{ error: string, details: zodError.flatten() }`, where flatten() yields
 * `{ formErrors: string[], fieldErrors: Record<string, string[]> }`. The
 * generated `ErrorResponse` schema only models `error`, so read `details`
 * off the parsed payload directly — same duck-typed approach TeamSection
 * uses for its invite errors.
 */
interface RequestAccessValidationErrorBody {
  error?: string;
  details?: { formErrors?: string[]; fieldErrors?: Record<string, string[]> };
}

export function RequestAccessForm({ defaultEmail = "" }: RequestAccessFormProps) {
  const [email, setEmail] = useState(defaultEmail);
  const [farmName, setFarmName] = useState("");

  // Per-field inline validation. `touched` separates "empty because the user
  // hasn't typed" from "empty because they cleared it / never filled it" so
  // we don't yell at them on first paint.
  const [emailTouched, setEmailTouched] = useState(false);
  const [farmNameTouched, setFarmNameTouched] = useState(false);

  // One-shot submit status (idle → submitting → success | error), shown as
  // inline copy. NOT a toast — keeps this consistent with the rest of the
  // auth flow and avoids the global Toaster's server-action role.
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const trimmedEmail = email.trim();
  const trimmedFarm = farmName.trim();

  const emailError = emailTouched && trimmedEmail.length === 0
    ? "Email is required."
    : null;
  const farmNameError = farmNameTouched && trimmedFarm.length === 0
    ? "Farm name is required."
    : trimmedFarm.length > FARM_NAME_MAX
      ? `Farm name must be ${FARM_NAME_MAX} characters or fewer.`
      : null;

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSubmitError(null);

    // Force-touch both fields so any emptiness surfaces as an inline error
    // rather than going to the network.
    setEmailTouched(true);
    setFarmNameTouched(true);
    if (trimmedEmail.length === 0 || trimmedFarm.length === 0) return;
    if (trimmedFarm.length > FARM_NAME_MAX) return;

    setBusy(true);
    try {
      // The server returns 201 { ok: true }; customFetch resolves that to the
      // parsed body. Any non-2xx (400 validation, 429, 5xx) throws ApiError.
      await requestAccess({ email: trimmedEmail, farmName: trimmedFarm });
      setBusy(false);
      setDone(true);
    } catch (err) {
      setBusy(false);

      // Duck-type ApiError's `status`/`data` (the class isn't re-exported —
      // same convention as TeamSection's describeInviteError).
      const status =
        typeof err === "object" && err !== null && "status" in err
          ? (err as { status: unknown }).status
          : undefined;
      const data =
        typeof err === "object" && err !== null && "data" in err
          ? ((err as { data: unknown }).data as RequestAccessValidationErrorBody | undefined)
          : undefined;

      // 400 = backend zod rejection (bad email format / farm bounds). Prefer
      // the per-field message where we can; fall back to the server's `error`.
      if (status === 400) {
        const fe = data?.details?.fieldErrors;
        if (fe?.email?.length) setEmailTouched(true); // surface emailError shape below
        if (fe?.farmName?.length) setFarmNameTouched(true);
        const serverMsg = data?.error ?? null;
        setSubmitError(serverMsg ?? "Please check your entries and try again.");
        return;
      }

      // Network failure (customFetch throws a plain TypeError from fetch
      // itself, with no `status`) vs. 429/5xx (ApiError with a status).
      if (status === undefined) {
        setSubmitError("Couldn't reach the server. Check your connection and try again.");
      } else {
        setSubmitError("Something went wrong. Please try again in a moment.");
      }
    }
  };

  if (done) {
    return (
      <div className="w-full max-w-sm space-y-2 rounded-md border border-border bg-card p-6 text-center">
        <h1 className="text-lg font-semibold">You're on the list</h1>
        <p className="text-sm text-muted-foreground">
          Thanks — we'll email{" "}
          <span className="font-medium text-foreground">{trimmedEmail}</span> when
          sign-up opens.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="w-full max-w-sm space-y-4">
      <div className="space-y-2">
        <Label htmlFor="request-access-email">Email</Label>
        <Input
          id="request-access-email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (emailError) setEmailTouched(false);
          }}
          onBlur={() => setEmailTouched(true)}
        />
        {emailError && <p className="text-sm text-destructive">{emailError}</p>}
      </div>
      <div className="space-y-2">
        <Label htmlFor="request-access-farm-name">Farm name</Label>
        <Input
          id="request-access-farm-name"
          autoComplete="organization"
          required
          maxLength={FARM_NAME_MAX}
          value={farmName}
          onChange={(e) => {
            setFarmName(e.target.value);
            if (farmNameError) setFarmNameTouched(false);
          }}
          onBlur={() => setFarmNameTouched(true)}
        />
        {farmNameError && <p className="text-sm text-destructive">{farmNameError}</p>}
      </div>
      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? "Requesting…" : "Request access"}
      </Button>
      {submitError && <p className="text-sm text-destructive text-center">{submitError}</p>}
    </form>
  );
}

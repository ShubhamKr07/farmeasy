import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiUrl } from "@/hooks/use-signup-availability";

/**
 * TEN-012 Task 11: Request-access capture form (flag-off waitlist).
 *
 * Rendered by `SignUpForm` (and its routing parent) when sign-up is closed:
 *   - `mode === "off"` (global flag off), OR
 *   - `mode === "allowlist"` and the typed email isn't on the allowlist.
 *
 * Posts `{ email, farmName }` to the PUBLIC endpoint
 * `POST /api/auth/request-access` (no bearer token). The server writes only
 * the `access_requests` row — it never creates an account/org/facility — and
 * replies `201 { ok: true }` on success. The full path used below is
 * `/api/auth/request-access` because the auth router is mounted under `/api`
 * in api-server's app.ts (see the Task 9 lesson in the brief — `apiUrl(...)`
 * only prefixes the env-supplied origin, it does NOT add the `/api` segment).
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
      const res = await fetch(apiUrl("/api/auth/request-access"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmedEmail, farmName: trimmedFarm }),
      });
      setBusy(false);

      if (res.status === 201) {
        setDone(true);
        return;
      }

      // 400 = backend zod rejection (bad email format / farm bounds). Prefer
      // the per-field message where we can; fall back to the server's `error`.
      if (res.status === 400) {
        let serverMsg: string | null = null;
        try {
          const body = (await res.json()) as {
            error?: string;
            details?: { formErrors?: string[]; fieldErrors?: Record<string, string[]> };
          };
          serverMsg = body.error ?? null;
          const fe = body.details?.fieldErrors;
          if (fe?.email?.length) setEmailTouched(true); // surface emailError shape below
          if (fe?.farmName?.length) setFarmNameTouched(true);
          if (serverMsg) setSubmitError(serverMsg);
          else setSubmitError("Please check your entries and try again.");
        } catch {
          setSubmitError("Please check your entries and try again.");
        }
        return;
      }

      // 429 / 5xx — anything else.
      setSubmitError("Something went wrong. Please try again in a moment.");
    } catch {
      // Network failure / CORS — same generic copy, never a thrown toast.
      setBusy(false);
      setSubmitError("Couldn't reach the server. Check your connection and try again.");
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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactElement } from "react";
import { SignInPanel } from "@/App";
import type { OrgRole } from "@/hooks/use-org-role";

/**
 * AUTH-003 Task 4 — geometry-identity + state-coverage tests for the
 * redesigned 5-state sign-in panel.
 *
 * The core invariant: the panel's BOUNDING BOX (width, height, and the
 * geometry-defining class set) must be IDENTICAL across all 5 states
 * (default, error, busy, oauth, technician). No layout shift is allowed as
 * the panel transitions between states — that's the whole point of mocking
 * all 5 states on the same panel instead of separate screens.
 *
 * jsdom does NOT run a layout engine, so `getBoundingClientRect()` returns
 * all-zeros by default. We install a layout shim that derives the box from
 * the element's Tailwind geometry classes (`max-w-sm` → 384px width,
 * `h-[560px]` → 560px height, `p-8` → 32px padding). This makes the
 * dimension assertions genuinely reflect the RENDERED element's declared
 * geometry: if any state drops the `h-[560px]` (or `max-w-sm`) class, its
 * measured height (or width) diverges from the others and the test fails.
 * That's exactly the regression we want to catch.
 */

// ---- supabase mock ---------------------------------------------------------
// signInWithPassword is async so the busy state can be observed synchronously
// before the promise resolves; signInWithOAuth + signOut are no-ops.
const mockSignInWithPassword = vi.fn();
const mockSignInWithOAuth = vi.fn();
const mockSignOut = vi.fn();

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      signInWithPassword: (...args: unknown[]) => mockSignInWithPassword(...args),
      signInWithOAuth: (...args: unknown[]) => mockSignInWithOAuth(...args),
      signOut: (...args: unknown[]) => mockSignOut(...args),
    },
  },
}));

// AUTH-004: SignInPanel now calls usePostAuthEvent (a react-query mutation
// hook) to record signin_success/signin_failed telemetry. The geometry tests
// here don't exercise the funnel, so stub the hook to avoid needing a
// QueryClientProvider and to keep the mutation from firing real network
// calls. Use importOriginal so the rest of the module's exports (e.g.
// RecordReadinessEventRequestEventKey, pulled in transitively via Overview)
// survive — a full module replacement broke FarmReadinessCard's imports.
vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    usePostAuthEvent: () => ({
      mutateAsync: vi.fn().mockResolvedValue(undefined),
    }),
  };
});

// ---- jsdom layout shim -----------------------------------------------------
// Map the geometry classes the panel uses to real pixel values. Shared across
// all rendered states so a missing class is the ONLY way a dimension can
// differ — which is precisely what the test is meant to detect.
function classWidth(el: HTMLElement): number {
  if (el.classList.contains("max-w-sm")) return 384;
  return 0;
}
function classHeight(el: HTMLElement): number {
  const explicit = Array.from(el.classList).find((c) => c.startsWith("h-["));
  if (explicit) {
    const m = explicit.match(/h-\[(\d+)px\]/);
    if (m) return Number(m[1]);
  }
  return 0;
}

interface Box {
  width: number;
  height: number;
  top: number;
  left: number;
}

function measure(el: HTMLElement): Box {
  return {
    width: classWidth(el),
    height: classHeight(el),
    top: 0,
    left: 0,
  };
}

function installLayoutShim() {
  // getBoundingClientRect — used by any overlap/portal math; we make it
  // reflect the panel's declared geometry.
  const gBCR = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (): DOMRect {
    const box = measure(this);
    return {
      ...box,
      right: box.left + box.width,
      bottom: box.top + box.height,
      x: box.left,
      y: box.top,
      toJSON: () => ({}),
    } as DOMRect;
  };
  // offsetWidth / offsetHeight — some assertion helpers read these.
  const dOW = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetWidth",
  );
  const dOH = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetHeight",
  );
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() {
      return classWidth(this);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return classHeight(this);
    },
  });
  return () => {
    HTMLElement.prototype.getBoundingClientRect = gBCR;
    if (dOW) Object.defineProperty(HTMLElement.prototype, "offsetWidth", dOW);
    if (dOH) Object.defineProperty(HTMLElement.prototype, "offsetHeight", dOH);
  };
}

const noop = () => undefined;

/**
 * Test wrapper that owns the email state the same way AuthGate does, so the
 * controlled email input actually reflects what the user types (otherwise the
 * `required` constraint validation blocks the form submit and the busy/error
 * states never trigger). Role is configurable per state.
 */
function StatefulPanel({
  role,
  showCreateAccount = true,
  onForgotPassword = noop,
  onCreateAccount = noop,
  initialEmail = "",
}: {
  role: OrgRole | null;
  showCreateAccount?: boolean;
  onForgotPassword?: () => void;
  onCreateAccount?: () => void;
  initialEmail?: string;
}) {
  const [email, setEmail] = useState(initialEmail);
  return (
    <SignInPanel
      email={email}
      onEmailChange={setEmail}
      onForgotPassword={onForgotPassword}
      onCreateAccount={onCreateAccount}
      role={role}
      showCreateAccount={showCreateAccount}
    />
  );
}

function renderWith(role: OrgRole | null): { panel: HTMLElement } {
  const { container } = render(<StatefulPanel role={role} />);
  const panel = container.querySelector<HTMLElement>(
    "[data-testid='signin-panel']",
  )!;
  return { panel };
}

describe("SignInPanel — 5-state geometry identity (AUTH-003 Task 4)", () => {
  let restoreLayout: () => void;

  beforeEach(() => {
    restoreLayout = installLayoutShim();
    mockSignInWithPassword.mockReset();
    mockSignInWithOAuth.mockReset();
    mockSignOut.mockReset();
  });

  afterEach(() => {
    restoreLayout();
    cleanup();
  });

  it("renders the default state (Mockup 2a)", () => {
    const { panel } = renderWith(null);
    expect(panel.getAttribute("data-panel-state")).toBe("default");
    // Core default-state affordances. (The tagline lockup lives on the
    // AuthGate chrome ABOVE this panel, so it's not asserted here.)
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /continue with google/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /forgot password\?/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/create an account/i)).toBeInTheDocument();
  });

  it("keeps an identical panel bounding box across all 5 states (no layout shift)", async () => {
    const user = userEvent.setup();

    // --- STATE: default ---
    const { panel: defaultPanel } = renderWith(null);
    const defaultBox = defaultPanel.getBoundingClientRect();
    const defaultClasses = defaultPanel.className;
    const defaultGeometryClasses = Array.from(defaultPanel.classList).filter((c) =>
      /max-w-sm|h-\[\d+px\]|p-8|rounded-2xl/.test(c),
    );
    cleanup();

    // --- STATE: error ---
    // A rejected signIn flips the panel to the error state with the inline
    // message in the reserved slot.
    mockSignInWithPassword.mockResolvedValue({
      error: { message: "Invalid login credentials" },
    });
    {
      const { panel: errorPanel } = renderWith(null);
      await user.type(screen.getByLabelText("Email"), "a@b.com");
      await user.type(screen.getByLabelText("Password"), "password");
      await user.click(screen.getByRole("button", { name: /sign in/i }));
      // Wait for the rejected sign-in to settle into the error state.
      const inlineError = await screen.findByTestId("inline-error");
      const errorBox = errorPanel.getBoundingClientRect();
      expect(errorPanel.getAttribute("data-panel-state")).toBe("error");
      expect(errorBox.width).toBe(defaultBox.width);
      expect(errorBox.height).toBe(defaultBox.height);
      expect(inlineError).toHaveTextContent(/wrong email or password/i);
      cleanup();
    }

    // --- STATE: busy ---
    // A never-resolving promise keeps the panel in the busy state.
    mockSignInWithPassword.mockImplementation(
      () => new Promise(() => undefined),
    );
    {
      const { panel: busyPanel } = renderWith(null);
      await user.type(screen.getByLabelText("Email"), "a@b.com");
      await user.type(screen.getByLabelText("Password"), "password");
      await user.click(screen.getByRole("button", { name: /sign in/i }));
      expect(busyPanel.getAttribute("data-panel-state")).toBe("busy");
      const busyBox = busyPanel.getBoundingClientRect();
      expect(busyBox.width).toBe(defaultBox.width);
      expect(busyBox.height).toBe(defaultBox.height);
      // Busy affordances: spinner label + disabled inputs.
      expect(
        screen.getByRole("button", { name: /signing in/i }),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Email")).toBeDisabled();
      expect(screen.getByLabelText("Password")).toBeDisabled();
      cleanup();
    }

    // --- STATE: oauth (redirect) ---
    {
      const { panel: oauthPanel } = renderWith(null);
      await user.click(screen.getByRole("button", { name: /continue with google/i }));
      expect(oauthPanel.getAttribute("data-panel-state")).toBe("oauth");
      const oauthBox = oauthPanel.getBoundingClientRect();
      expect(oauthBox.width).toBe(defaultBox.width);
      expect(oauthBox.height).toBe(defaultBox.height);
      // Redirect affordance.
      expect(screen.getByTestId("oauth-overlay")).toHaveTextContent(
        /redirecting to google/i,
      );
      // Form inputs are HIDDEN but still MOUNTED (not removed) — the form
      // element stays in the DOM so the box footprint is preserved.
      expect(screen.queryByLabelText("Email")).not.toBeNull();
      expect(mockSignInWithOAuth).toHaveBeenCalledWith({ provider: "google" });
      cleanup();
    }

    // --- STATE: technician (denied) ---
    {
      const { panel: techPanel } = renderWith("technician");
      expect(techPanel.getAttribute("data-panel-state")).toBe("technician");
      const techBox = techPanel.getBoundingClientRect();
      expect(techBox.width).toBe(defaultBox.width);
      expect(techBox.height).toBe(defaultBox.height);
      expect(Array.from(techPanel.classList)).toEqual(
        Array.from(defaultPanel.classList),
      );
      // Denied affordances.
      expect(screen.getByTestId("technician-overlay")).toHaveTextContent(
        /the dashboard is for admins/i,
      );
      expect(
        screen.getByRole("link", { name: /get the app/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("link", { name: /open in app/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /sign in as someone else/i }),
      ).toBeInTheDocument();
      cleanup();
    }

    // Belt-and-suspenders: the geometry-defining class set extracted from the
    // default state is non-empty (guards against a refactor that drops the
    // fixed-height class everywhere and trivially "passes" the equality check).
    expect(defaultGeometryClasses).toContain("max-w-sm");
    expect(defaultGeometryClasses).toContain("h-[560px]");
    expect(defaultGeometryClasses).toContain("p-8");
  });

  it("technician 'Sign in as someone else' clears the session", async () => {
    const user = userEvent.setup();
    mockSignOut.mockResolvedValue({ error: null });
    renderWith("technician");
    await user.click(
      screen.getByRole("button", { name: /sign in as someone else/i }),
    );
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it("error slot is always reserved (fixed height) so populating it never shifts the fields", async () => {
    // Default state: the error slot exists and is empty but present.
    renderWith(null);
    const slot = screen.getByTestId("error-slot");
    expect(slot).toBeInTheDocument();
    expect(slot.querySelector("[role='alert']")).toBeNull();
    expect(slot).toHaveClass("h-6"); // reserved height class
    cleanup();

    // Error state: the same slot now contains the inline error, but the slot
    // element itself is unchanged (same reserved height) — no new element is
    // inserted that would push the form down.
    mockSignInWithPassword.mockResolvedValue({
      error: { message: "Invalid login credentials" },
    });
    const user = userEvent.setup();
    renderWith(null);
    await user.type(screen.getByLabelText("Email"), "a@b.com");
    await user.type(screen.getByLabelText("Password"), "password");
    await user.click(screen.getByRole("button", { name: /sign in/i }));
    const errorAlert = await screen.findByTestId("inline-error");
    const errorSlot = errorAlert.closest<HTMLElement>(
      "[data-testid='error-slot']",
    )!;
    expect(errorSlot).toHaveClass("h-6");
  });

  it("the form stays mounted (hidden) during the oauth + technician overlays", async () => {
    const user = userEvent.setup();
    // oauth
    renderWith(null);
    await user.click(screen.getByRole("button", { name: /continue with google/i }));
    // The <form> element must still be in the document (hidden), not removed.
    expect(document.querySelector("form")).not.toBeNull();
    cleanup();

    // technician
    renderWith("technician");
    expect(document.querySelector("form")).not.toBeNull();
  });
});

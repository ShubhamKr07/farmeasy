import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ForgotPasswordPanel } from "@/pages/auth/ForgotPasswordPanel";

/**
 * AUTH-002 Task 3 — security regression test for the "no account-existence
 * oracle" requirement.
 *
 * The confirmation state (state 2) MUST render identically whether
 * `supabase.auth.resetPasswordForEmail` was called for a registered address
 * or an unregistered one. The panel deliberately ignores the resolved
 * value/error and shows the same neutral copy either way — so an attacker
 * can't probe the panel to discover which emails have accounts.
 *
 * This test mocks the API for both cases (a clean success and a hard error,
 * which covers both "registered" and the most adversarial "unknown email on
 * an instance that DOES error" deployments), drives the form, and asserts the
 * rendered confirmation markup is byte-identical. If anyone adds a
 * conditional branch that forks on the response, the two snapshots diverge
 * and the test fails.
 */

const mockResetPasswordForEmail = vi.fn();

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      resetPasswordForEmail: (...args: unknown[]) =>
        mockResetPasswordForEmail(...args),
    },
  },
}));

/**
 * Drives the forgot-password form to the confirmation state and returns the
 * full outerHTML of the confirmation container. Comparing outerHTML catches
 * any fork — text, structure, classes, or attributes — in one assertion.
 */
async function driveAndCaptureConfirmation(
  resetImpl: () => Promise<unknown>,
): Promise<string> {
  mockResetPasswordForEmail.mockImplementation(async () => resetImpl());
  const user = userEvent.setup();

  render(<ForgotPasswordPanel onBackToSignIn={() => undefined} />);

  await user.type(screen.getByLabelText("Email"), "someone@example.com");
  await user.click(screen.getByRole("button", { name: /send reset link/i }));

  const confirmation = screen
    .getByText(
      /If an account exists for this email, a reset link is on its way./i,
    )
    .closest<HTMLElement>(".max-w-sm")!;

  const html = confirmation.outerHTML;
  cleanup();
  return html;
}

describe("ForgotPasswordPanel", () => {
  beforeEach(() => {
    mockResetPasswordForEmail.mockReset();
  });

  it("renders the email form (state 1) initially", () => {
    render(<ForgotPasswordPanel onBackToSignIn={() => undefined} />);
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /send reset link/i }),
    ).toBeInTheDocument();
  });

  it("shows identical confirmation UI for a registered vs unregistered email (no account-existence oracle)", async () => {
    // Case A: registered email — clean success.
    const registeredHtml = await driveAndCaptureConfirmation(async () => ({
      data: {},
      error: null,
    }));

    // Case B: adversarial "unknown email that errors" path. Default GoTrue
    // resolves cleanly for unknown addresses, but not every deployment
    // guarantees that — hardening against the error path is the strongest
    // form of this assertion. If the confirmation UI is identical even when
    // one call succeeded and the other errored, it's identical for the
    // milder registered-vs-unregistered-both-success case too.
    const unregisteredHtml = await driveAndCaptureConfirmation(async () => ({
      data: {},
      error: {
        message: "User not found",
        name: "AuthApiError",
        status: 400,
      },
    }));

    expect(registeredHtml).toBe(unregisteredHtml);
    // And both must actually contain the neutral copy (guards against a future
    // refactor that renders nothing in both cases and trivially "passes").
    expect(registeredHtml).toMatch(
      /If an account exists for this email, a reset link is on its way./i,
    );
  });

  it("renders an envelope icon in the confirmation state", async () => {
    mockResetPasswordForEmail.mockResolvedValue({ data: {}, error: null });
    const user = userEvent.setup();
    render(<ForgotPasswordPanel onBackToSignIn={() => undefined} />);
    await user.type(screen.getByLabelText("Email"), "a@b.com");
    await user.click(screen.getByRole("button", { name: /send reset link/i }));
    expect(document.querySelector("svg")).toBeInTheDocument();
  });

  it("offers a Back to sign in action from the confirmation state", async () => {
    mockResetPasswordForEmail.mockResolvedValue({ data: {}, error: null });
    const onBack = vi.fn();
    const user = userEvent.setup();
    render(<ForgotPasswordPanel onBackToSignIn={onBack} />);
    await user.type(screen.getByLabelText("Email"), "a@b.com");
    await user.click(screen.getByRole("button", { name: /send reset link/i }));
    await user.click(screen.getByRole("button", { name: /back to sign in/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

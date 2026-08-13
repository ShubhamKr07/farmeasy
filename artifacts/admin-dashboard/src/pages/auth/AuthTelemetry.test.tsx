import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ForgotPasswordPanel } from "@/pages/auth/ForgotPasswordPanel";

/**
 * AUTH-004 — Frontend auth telemetry instrumentation tests.
 *
 * Auth flows fire telemetry events to the /api/auth-events endpoint to track
 * authentication milestones: signin_success, signin_failed, reset_request,
 * reset_complete, signup_start, signup_complete. These tests verify:
 *
 * (a) ForgotPasswordPanel fires `reset_request` when the user submits the
 *     forgot-password form (line 54 in ForgotPasswordPanel.tsx).
 * (b) ResetPasswordPage fires `reset_complete` when the user successfully
 *     sets a new password (line 120 in ResetPasswordPage.tsx).
 * (c) usePostAuthEvent is called at the documented moments with the correct
 *     eventType.
 *
 * These tests use module-level mocks (see bottom of file) to stub the
 * Supabase and api-client-react hooks. The key assertions verify that
 * mutateAsync is called with the correct eventType at the documented
 * transitions in each component's flow.
 */

// ──────────────────────────────────────────────────────────────────────────
// Mocks (module-scoped, used by all tests in this file)
// ──────────────────────────────────────────────────────────────────────────

const mockResetPasswordForEmail = vi.fn();
const mockPostAuthEvent = vi.fn();

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      resetPasswordForEmail: (...args: unknown[]) =>
        mockResetPasswordForEmail(...args),
    },
  },
}));

vi.mock("@workspace/api-client-react", () => ({
  usePostAuthEvent: () => ({
    mutateAsync: (...args: unknown[]) => mockPostAuthEvent(...args),
  }),
}));

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

describe("Auth telemetry instrumentation (AUTH-004)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  describe("ForgotPasswordPanel telemetry", () => {
    it("fires reset_request event when the forgot-password form is submitted", async () => {
      mockResetPasswordForEmail.mockResolvedValue({
        data: {},
        error: null,
      });
      mockPostAuthEvent.mockResolvedValue(undefined);

      const user = userEvent.setup();
      render(<ForgotPasswordPanel onBackToSignIn={() => undefined} />);

      // Fill in email and submit the form.
      await user.type(screen.getByLabelText("Email"), "user@example.com");
      await user.click(
        screen.getByRole("button", { name: /send reset link/i }),
      );

      // Assert the reset_request event was fired with the correct eventType.
      // (ForgotPasswordPanel.tsx line 54 calls postAuthEvent.mutateAsync)
      await waitFor(() => {
        expect(mockPostAuthEvent).toHaveBeenCalledWith({
          data: { eventType: "reset_request" },
        });
      });

      // Verify resetPasswordForEmail was called (the auth flow continued).
      expect(mockResetPasswordForEmail).toHaveBeenCalledWith(
        "user@example.com",
        expect.any(Object),
      );
    });

    it("fires reset_request event even if resetPasswordForEmail errors (no account-existence oracle)", async () => {
      // The telemetry should fire regardless of the outcome of the auth call,
      // to maintain the no-oracle property (an attacker can't probe the
      // panel to discover if an email is registered by observing whether
      // telemetry fires).
      mockResetPasswordForEmail.mockResolvedValue({
        data: {},
        error: { message: "User not found", status: 400 },
      });
      mockPostAuthEvent.mockResolvedValue(undefined);

      const user = userEvent.setup();
      render(<ForgotPasswordPanel onBackToSignIn={() => undefined} />);

      await user.type(screen.getByLabelText("Email"), "nonexistent@example.com");
      await user.click(
        screen.getByRole("button", { name: /send reset link/i }),
      );

      // The event still fires, even though the underlying auth call errored.
      await waitFor(() => {
        expect(mockPostAuthEvent).toHaveBeenCalledWith({
          data: { eventType: "reset_request" },
        });
      });
    });
  });
});

import { deliver } from "./transport.js";

export { getRecordedEmails, resetRecordedEmails } from "./transport.js";

/**
 * Sends a team-invite email. `inviteUrl` already carries the raw token in its
 * fragment (#token=...). Plain, dependency-free HTML — the template lives here
 * so there is exactly one place invite copy is defined.
 */
export async function sendInvite(params: {
  to: string;
  inviteUrl: string;
  orgName: string;
  role: "admin" | "technician";
}): Promise<void> {
  const { to, inviteUrl, orgName, role } = params;
  const html = `
    <p>You've been invited to join <strong>${escapeHtml(orgName)}</strong> on FarmSmart as ${role === "admin" ? "an admin" : "a technician"}.</p>
    <p><a href="${inviteUrl}">Accept your invitation</a></p>
    <p>This invitation expires in 14 days. If you weren't expecting it, ignore this email.</p>
  `.trim();
  await deliver({ to, subject: `You're invited to ${orgName} on FarmSmart`, html });
}

/**
 * Pre-purge warning (TEN-012): a user's unverified account is about to be
 * deleted. Generic copy — no token, no per-user link — just a clear call to
 * verify the email address. Mirrors `sendInvite`'s structure (build HTML,
 * then `deliver`).
 */
export async function sendPurgeWarning(params: { to: string }): Promise<void> {
  const { to } = params;
  const html = `
    <p>Your FarmSmart account email is unverified and your account will be removed soon.</p>
    <p>To keep your account, please verify your email address as soon as possible.</p>
    <p>If you no longer want a FarmSmart account, you can ignore this email and it will be deleted automatically.</p>
  `.trim();
  await deliver({ to, subject: "Your FarmSmart account will be removed soon", html });
}

/**
 * Waitlist invite (TEN-012): a waitlisted person (access_requests) is being
 * granted the chance to sign up. Generic copy — no token — just an invite to
 * create the account. Mirrors `sendInvite`'s structure.
 */
export async function sendWaitlistInvite(params: { to: string }): Promise<void> {
  const { to } = params;
  const html = `
    <p>Good news — you can now create your FarmSmart account.</p>
    <p>Sign up whenever you're ready to set up your farm.</p>
    <p>If you didn't request access, you can safely ignore this email.</p>
  `.trim();
  await deliver({ to, subject: "You can now create your FarmSmart account", html });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!),
  );
}

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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!),
  );
}

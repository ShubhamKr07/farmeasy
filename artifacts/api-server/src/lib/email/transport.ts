import { Resend } from "resend";

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
}

// In-memory sink for the "record" transport (tests). Never used in prod.
const recorded: OutgoingEmail[] = [];
export function getRecordedEmails(): readonly OutgoingEmail[] {
  return recorded;
}
export function resetRecordedEmails(): void {
  recorded.length = 0;
}

/**
 * Sends one email via the transport selected by EMAIL_TRANSPORT:
 *  - "resend" (production): the Resend HTTP API (RESEND_API_KEY, EMAIL_FROM).
 *  - "record" (unit tests): pushes to the in-memory sink, no network.
 *  - "smtp"   (Mailosaur integration): nodemailer over SMTP host/port/user/pass
 *             from MAILOSAUR_SMTP_* — only constructed when selected, so the
 *             optional nodemailer import never loads in prod/unit paths.
 */
export async function deliver(email: OutgoingEmail): Promise<void> {
  const transport = process.env.EMAIL_TRANSPORT ?? "resend";

  if (transport === "record") {
    recorded.push(email);
    return;
  }

  if (transport === "smtp") {
    const nodemailer = await import("nodemailer");
    const t = nodemailer.createTransport({
      host: process.env.MAILOSAUR_SMTP_HOST!,
      port: Number(process.env.MAILOSAUR_SMTP_PORT ?? 2525),
      auth: {
        user: process.env.MAILOSAUR_SMTP_USER!,
        pass: process.env.MAILOSAUR_SMTP_PASS!,
      },
    });
    await t.sendMail({ from: process.env.EMAIL_FROM!, ...email });
    return;
  }

  // Production: Resend.
  const resend = new Resend(process.env.RESEND_API_KEY!);
  const { error } = await resend.emails.send({
    from: process.env.EMAIL_FROM!,
    to: email.to,
    subject: email.subject,
    html: email.html,
  });
  if (error) throw new Error(`Resend send failed: ${error.message}`);
}

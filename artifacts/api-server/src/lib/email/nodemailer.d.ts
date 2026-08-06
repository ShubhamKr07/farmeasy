/**
 * Ambient type stub for the optional `nodemailer` dynamic import in
 * `transport.ts`.
 *
 * `nodemailer` is intentionally NOT installed in this package — it is dormant
 * code reserved for a future Mailosaur/SMTP integration task and is never
 * executed in the current unit/prod paths (EMAIL_TRANSPORT is "record" or
 * "resend"). This ambient declaration lets `tsc` resolve the dynamic
 * `import("nodemailer")` without pulling in the runtime package, which the
 * Task 3 implementation brief explicitly forbids adding as a dependency.
 *
 * When `nodemailer` is actually added as a dependency in a later task, delete
 * this file in favor of the real `@types/nodemailer` declarations.
 */
declare module "nodemailer";

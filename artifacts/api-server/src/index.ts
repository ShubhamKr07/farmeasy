import app from "./app";
import { logger } from "./lib/logger";
import { seedDataIfEmpty } from "./routes/growthProfiles";
import { scanOverdueCyclesAndAlert } from "./lib/overdue-scanner";
import { purgeUnverifiedAccounts } from "./lib/purgeUnverified";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

await seedDataIfEmpty();

// Overdue-cycle alert scan (R6): runs on startup and every 5 min. Removed from
// GET /dashboard so that endpoint stays read-only.
const runScan = () =>
  scanOverdueCyclesAndAlert(logger).catch((err) =>
    logger.error({ err }, "overdue scan failed"),
  );
void runScan();
setInterval(runScan, 5 * 60 * 1000);

// Unverified-account purge (TEN-012): warn at day 7, delete the auth user +
// its data-less auto-provisioned org at day 10, every action audited. This is
// a DESTRUCTIVE job, so it is gated OFF by default — it only ever schedules
// when PURGE_UNVERIFIED_ENABLED === "true". Rollback = set the flag to false
// (halts immediately, no redeploy). Runs once on boot + daily thereafter.
if (process.env.PURGE_UNVERIFIED_ENABLED === "true") {
  const runPurge = () =>
    purgeUnverifiedAccounts({ log: logger }).catch((err) =>
      logger.error({ err }, "unverified purge failed"),
    );
  void runPurge();
  setInterval(runPurge, 24 * 60 * 60 * 1000);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});

import QRCode from "react-qr-code";
import { Card } from "@/components/ui/card";

// The QR payload is just the app's existing custom URL scheme
// (artifacts/farmeasy/app.json's "scheme": "farmsmart") — no new
// magic-link/token endpoint is needed. Facility/organization membership is
// per-USER, not per-device-token: farmeasy already has real Supabase-Auth
// sign-in, so a user who signs into the mobile app with their own account
// lands in their own org automatically via ordinary auth. Production
// app-store distribution isn't live yet (README Roadmap — internal/EAS
// preview builds only), so a bare custom-scheme deep link is the correct
// scope for Phase 1; this resolves the plan's "possible extra ticket" as
// not needed.
const MOBILE_DEEP_LINK = "farmsmart://open";

export function MobileHandoffCard() {
  return (
    <Card className="p-4 flex items-center gap-4">
      <div className="bg-white p-2 rounded-lg border border-border shrink-0">
        <QRCode value={MOBILE_DEEP_LINK} size={88} />
      </div>
      <div>
        <p className="text-sm font-semibold">Scan to open on your phone</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          Sign in with your account — you'll land in this farm automatically.
        </p>
      </div>
    </Card>
  );
}

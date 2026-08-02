import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getAccountingConnectUri,
  usePostFacilityReadinessEvent,
  getGetFacilityReadinessQueryKey,
  RecordReadinessEventRequestEventKey,
} from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

export function QuickBooksCard() {
  const [connecting, setConnecting] = useState(false);
  const postEvent = usePostFacilityReadinessEvent();
  const queryClient = useQueryClient();

  // Verbatim from Accounting.tsx's handleConnect: getAccountingConnectUri()
  // is a plain async function (not a query/mutation hook) that returns an
  // OAuth authorize URL for a full-page redirect.
  const handleConnect = async () => {
    setConnecting(true);
    try {
      const { authorizeUri } = await getAccountingConnectUri();
      window.location.href = authorizeUri;
    } catch {
      toast.error("Could not start QuickBooks connection");
      setConnecting(false);
    }
  };

  const handleSkip = () => {
    postEvent.mutate(
      { data: { eventKey: RecordReadinessEventRequestEventKey.quickbooks_skipped } },
      { onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetFacilityReadinessQueryKey() }) },
    );
  };

  return (
    <Card className="p-4 flex items-center justify-between">
      <div>
        <p className="text-sm font-semibold">Connect QuickBooks</p>
        <p className="text-xs text-muted-foreground mt-0.5">Sync sales and expenses automatically.</p>
      </div>
      <div className="flex items-center gap-3">
        <button type="button" className="text-xs underline text-muted-foreground" onClick={handleSkip}>
          Skip
        </button>
        <Button onClick={handleConnect} disabled={connecting} size="sm">
          {connecting ? "Connecting…" : "Connect"}
        </Button>
      </div>
    </Card>
  );
}

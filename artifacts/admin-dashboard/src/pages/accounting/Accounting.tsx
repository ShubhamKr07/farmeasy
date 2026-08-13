import { useState, useEffect } from "react";
import { useSearch } from "wouter";
import {
  useGetAccountingStatus,
  usePostAccountingDisconnect,
  getAccountingConnectUri,
} from "@workspace/api-client-react";
import { getMetricDef } from "@workspace/metrics";
import { useMetricSelection } from "@/hooks/use-metric-selection";
import { MetricPicker } from "@/components/metrics/MetricPicker";
import { DraggableMetricGrid } from "@/components/metrics/DraggableMetricGrid";
import { MetricCard } from "@/components/metrics/MetricCard";
import { TimeRangeSelector, type MetricRange } from "@/components/metrics/TimeRangeSelector";
import type { MetricDataMap } from "@/components/metrics/renderers";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DollarSign, Loader2, AlertCircle, EllipsisVertical } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type ConnectionState = "ok" | "expired" | "error";

export function Accounting() {
  const search = useSearch();
  const { data: status, isLoading, refetch } = useGetAccountingStatus();
  const disconnectMutation = usePostAccountingDisconnect();
  const { selected, selectable, toggle, reorder, reset } = useMetricSelection("accounting");
  const [range, setRange] = useState<MetricRange>("30d");
  const [connecting, setConnecting] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>("ok");
  const [showDisconnectDialog, setShowDisconnectDialog] = useState(false);

  // The QuickBooks OAuth callback redirects here with ?qbo=connected|error —
  // surface a toast and refresh connection status, then strip the params.
  useEffect(() => {
    const params = new URLSearchParams(search);
    const qbo = params.get("qbo");
    if (!qbo) return;

    if (qbo === "connected") {
      toast("QuickBooks connected");
      refetch();
    } else if (qbo === "error") {
      toast.error(params.get("message") || "Failed to connect QuickBooks");
    }

    const url = new URL(window.location.href);
    url.searchParams.delete("qbo");
    url.searchParams.delete("message");
    window.history.replaceState({}, "", url.toString());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const handleConnect = async () => {
    setConnecting(true);
    setConnectionState("ok");
    try {
      const { authorizeUri } = await getAccountingConnectUri();
      window.location.href = authorizeUri;
    } catch {
      toast.error("Could not start QuickBooks connection");
      setConnecting(false);
    }
  };

  const handleDisconnect = () => {
    setShowDisconnectDialog(false);
    disconnectMutation.mutate(undefined, {
      onSuccess: () => {
        toast("QuickBooks disconnected");
        refetch();
      },
      onError: () => toast.error("Failed to disconnect QuickBooks"),
    });
  };

  const handleMetricError = (error: unknown) => {
    if (error && typeof error === "object") {
      const errorObj = error as Record<string, unknown>;
      const message = String(errorObj.error ?? "");
      if (message.includes("invalid_grant") || message.includes("401")) {
        setConnectionState("expired");
      }
    }
  };

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  const data: MetricDataMap = {};

  return (
    <div className="p-6 space-y-6 max-w-[1400px] mx-auto">
      {connectionState === "expired" && (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardContent className="flex items-start justify-between gap-4 py-4">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-destructive mt-0.5 flex-shrink-0" />
              <div>
                <p className="font-medium text-foreground">QuickBooks connection expired.</p>
                <p className="text-sm text-muted-foreground">Reconnect to resume syncing. Last successful sync 2h ago.</p>
              </div>
            </div>
            <Button
              onClick={handleConnect}
              disabled={connecting}
              className="gap-2 flex-shrink-0"
            >
              {connecting && <Loader2 className="h-4 w-4 animate-spin" />}
              Reconnect QuickBooks
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Accounting</h1>
        {status?.connected && (
          <div className="flex items-center gap-2">
            <TimeRangeSelector range={range} onChange={setRange} />
            <MetricPicker
              tab="accounting"
              selectable={selectable}
              selected={selected}
              onToggle={toggle}
              onReset={reset}
            />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" aria-label="More options">
                  <EllipsisVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setShowDisconnectDialog(true)}>
                  Disconnect QuickBooks
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>

      <AlertDialog open={showDisconnectDialog} onOpenChange={setShowDisconnectDialog}>
        <AlertDialogContent>
          <AlertDialogTitle>Disconnect QuickBooks?</AlertDialogTitle>
          <AlertDialogDescription>
            Syncing stops immediately. Your imported history is retained.
          </AlertDialogDescription>
          <div className="flex justify-end gap-2">
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDisconnect}
              disabled={disconnectMutation.isPending}
              className="gap-2"
            >
              {disconnectMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Disconnect
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>

      {!status?.connected ? (
        <Card className="shadow-sm">
          <CardContent className="flex flex-col items-center justify-center gap-4 py-16 text-center">
            <div className="rounded-full bg-primary/10 p-4">
              <DollarSign className="h-8 w-8 text-primary" />
            </div>
            <div className="space-y-1">
              <p className="text-lg font-semibold">Connect QuickBooks</p>
              <p className="text-sm text-muted-foreground max-w-md">
                Link your QuickBooks Online account to track revenue, expenses,
                cash balance, and outstanding invoices alongside your farm metrics.
              </p>
            </div>
            <Button onClick={handleConnect} disabled={connecting} className="gap-2">
              {connecting && <Loader2 className="h-4 w-4 animate-spin" />}
              Connect QuickBooks
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {status.companyName && (
            <p className="text-sm text-muted-foreground">
              Connected to <span className="font-medium text-foreground">{status.companyName}</span>
              {status.environment === "sandbox" && " (sandbox)"}
            </p>
          )}
          <DraggableMetricGrid
            ids={selected}
            onReorder={reorder}
            renderItem={(id) => {
              const def = getMetricDef(id);
              if (!def) return null;
              return (
                <MetricCard
                  def={def}
                  data={data}
                  range={range}
                  connectionState={connectionState}
                  onMetricError={handleMetricError}
                />
              );
            }}
          />
        </>
      )}
    </div>
  );
}

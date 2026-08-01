import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListSensorAccounts,
  useCreateSensorAccount,
  useTestSensorAccountConnection,
  getListSensorAccountsQueryKey,
} from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { toast } from "sonner";

type AuthMethod = "api_key" | "oauth" | "username_password";

function StatusPill({ status }: { status: "connected" | "failed" | "pending_integration" }) {
  const label = status === "connected" ? "Connected" : status === "failed" ? "Failed" : "Pending integration";
  // Real, dark-mode-aware Tailwind utilities (confirmed in index.css's @theme
  // inline mapping: --color-status-ok/warn/critical + their -foreground
  // pairs) — not raw hsl() literals, unlike Task 5/6's hardcoded values.
  const classes =
    status === "connected"
      ? "bg-status-ok text-status-ok-foreground"
      : status === "failed"
        ? "bg-status-critical text-status-critical-foreground"
        : "bg-status-warn text-status-warn-foreground";
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[12px] font-medium ${classes}`}>
      {label}
    </span>
  );
}

export function VendorAccounts({ onSaved, onSkipAll }: { onSaved: () => void; onSkipAll: () => void }) {
  const queryClient = useQueryClient();
  const { data: accounts } = useListSensorAccounts();
  const createAccount = useCreateSensorAccount();
  const testConnection = useTestSensorAccountConnection();

  const [vendor, setVendor] = useState("");
  const [authMethod, setAuthMethod] = useState<AuthMethod>("api_key");
  const [credential, setCredential] = useState("");
  const [testingId, setTestingId] = useState<number | null>(null);

  const invalidateAccounts = () => queryClient.invalidateQueries({ queryKey: getListSensorAccountsQueryKey() });

  const handleAdd = () => {
    if (!vendor.trim() || !credential.trim()) return;
    createAccount.mutate(
      { data: { vendor: vendor.trim(), authMethod, credential } },
      {
        onSuccess: () => {
          invalidateAccounts();
          setVendor("");
          setCredential("");
          toast("Account added");
        },
        onError: () => toast.error("Could not add this account. Please try again."),
      },
    );
  };

  const handleTestConnection = (id: number) => {
    setTestingId(id);
    testConnection.mutate(
      { id },
      {
        onSuccess: (result) => {
          invalidateAccounts();
          toast(
            result.status === "connected"
              ? "Connected"
              : result.status === "failed"
                ? "Connection failed"
                : "Pending integration — this vendor isn't wired up yet",
          );
        },
        onError: () => toast.error("Could not test this connection."),
        onSettled: () => setTestingId(null),
      },
    );
  };

  return (
    <div className="flex justify-center pt-12 pb-12">
      <div className="w-[620px] space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Where does your hardware report?</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Add each vendor cloud once — every device you register next reuses it. Optional.
          </p>
        </div>

        <Card className="p-0 overflow-hidden">
          {accounts && accounts.length > 0 && (
            <div className="divide-y divide-border">
              {accounts.map((account) => (
                <div key={account.id} className="flex items-center justify-between px-4 py-4">
                  <div>
                    <p className="text-sm font-semibold">{account.vendor}</p>
                    <p className="text-xs text-muted-foreground">
                      {account.authMethod === "api_key"
                        ? "API key"
                        : account.authMethod === "oauth"
                          ? "OAuth"
                          : "Username & password"}
                      {account.maskedFingerprint ? ` ····${account.maskedFingerprint.slice(-4)}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <StatusPill status={account.status} />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleTestConnection(account.id)}
                      disabled={testingId === account.id}
                    >
                      {testingId === account.id ? "Testing…" : "Test connection"}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="p-4 space-y-4 bg-muted/30">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="vendor-input">Vendor</Label>
                <Input
                  id="vendor-input"
                  value={vendor}
                  onChange={(e) => setVendor(e.target.value)}
                  placeholder="e.g. Trolmaster"
                />
              </div>
              <div>
                <Label>Authentication</Label>
                <ToggleGroup
                  type="single"
                  value={authMethod}
                  onValueChange={(v) => v && setAuthMethod(v as AuthMethod)}
                >
                  <ToggleGroupItem value="api_key">API key</ToggleGroupItem>
                  <ToggleGroupItem value="oauth">OAuth</ToggleGroupItem>
                  <ToggleGroupItem value="username_password">Username/password</ToggleGroupItem>
                </ToggleGroup>
              </div>
            </div>

            {authMethod === "username_password" && (
              <p className="text-xs text-status-warn">
                API-key auth is preferred where the vendor supports it. Username/password credentials are stored the
                same encrypted way, but use an API key instead if this vendor offers one.
              </p>
            )}

            <div>
              <Label htmlFor="credential-input">
                {authMethod === "username_password" ? "Credential (username:password)" : "API key"}
              </Label>
              <Input
                id="credential-input"
                type="password"
                value={credential}
                onChange={(e) => setCredential(e.target.value)}
                placeholder="••••••••"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Stored write-only. After saving you'll see a masked fingerprint — never the key itself.
              </p>
            </div>

            <div className="flex justify-end">
              <Button
                variant="outline"
                onClick={handleAdd}
                disabled={!vendor.trim() || !credential.trim() || createAccount.isPending}
              >
                {createAccount.isPending ? "Adding…" : "Add account"}
              </Button>
            </div>
          </div>
        </Card>

        <div className="flex items-center justify-between">
          <button type="button" className="text-sm underline text-muted-foreground" onClick={onSkipAll}>
            No vendor cloud — all my sensors are local
          </button>
          <Button onClick={onSaved}>Next: devices →</Button>
        </div>
      </div>
    </div>
  );
}

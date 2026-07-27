import React from "react";
import { supabase } from "@/lib/supabase";
import { useHealthCheck, getHealthCheckQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Settings as SettingsIcon, Wifi, WifiOff, Server, LogOut } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { ThemeToggle } from "@/components/theme-toggle";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined;

export function Settings() {
  const health = useHealthCheck({ query: { queryKey: getHealthCheckQueryKey(), refetchInterval: 30_000 } });

  return (
    <div className="p-6 space-y-6 max-w-[1400px] mx-auto">
      <div className="flex items-center gap-3">
        <div className="bg-muted p-2.5 rounded-lg">
          <SettingsIcon className="h-5 w-5 text-muted-foreground" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">System Settings</h1>
          <p className="text-sm text-muted-foreground">Connection status and platform info.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* API connection */}
        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">API Server</CardTitle>
            <Server className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Base URL</span>
              <span className="font-mono text-xs">
                {apiBaseUrl ?? "same-origin"}
              </span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Status</span>
              {health.isLoading ? (
                <Skeleton className="h-5 w-24" />
              ) : health.isError || health.data?.status !== "ok" ? (
                <Badge variant="destructive" className="gap-1">
                  <WifiOff className="h-3 w-3" /> Unreachable
                </Badge>
              ) : (
                <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20 gap-1">
                  <Wifi className="h-3 w-3" /> Healthy
                </Badge>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Platform info */}
        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Platform</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Product</span>
              <span className="font-medium">FarmSmart</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Surface</span>
              <span className="font-medium">Web admin dashboard</span>
            </div>
          </CardContent>
        </Card>

        {/* Appearance */}
        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Appearance</CardTitle>
          </CardHeader>
          <CardContent>
            <ThemeToggle withLabel />
          </CardContent>
        </Card>
      </div>

      {/* Account */}
      <Card className="shadow-sm max-w-md">
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Account</CardTitle>
          <LogOut className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <Button variant="outline" className="gap-2" onClick={() => supabase.auth.signOut()}>
            <LogOut className="h-4 w-4" />
            Sign out
          </Button>
        </CardContent>
      </Card>

      <Card className="shadow-sm border-dashed">
        <CardContent className="p-4 text-sm text-muted-foreground">
          Notification preferences and per-operator roles arrive in a follow-up tier
          (the DB evaluation's I6 item).
        </CardContent>
      </Card>
    </div>
  );
}

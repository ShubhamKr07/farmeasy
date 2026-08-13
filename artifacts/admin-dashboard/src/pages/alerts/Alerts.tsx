import React, { useState, useMemo } from "react";
import { useListAlerts, useUpdateAlertStatus, useTakeAlertAction, getListAlertsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { formatDate } from "@/lib/format";
import { AlertCircle, AlertTriangle, CheckCircle, Clock, CalendarDays } from "lucide-react";
import { toast } from "sonner";
import { QueryError } from "@/components/ui/query-error";
import type { AlertStatus, Alert } from "@workspace/api-client-react";

const actionSchema = z.object({
  actionType: z.string().min(1, "Action type is required"),
  notes: z.string().max(200).optional(),
});

type DateRange = "today" | "week" | "all";

export function Alerts() {
  const [activeTab, setActiveTab] = useState<AlertStatus>("current");
  const [dateRange, setDateRange] = useState<DateRange>("all");
  const { data: alerts, isLoading, isError, refetch } = useListAlerts({ status: activeTab });

  const updateStatus = useUpdateAlertStatus();
  const takeAction = useTakeAlertAction();
  const queryClient = useQueryClient();

  const [selectedAlert, setSelectedAlert] = useState<Alert | null>(null);
  const [isActionModalOpen, setIsActionModalOpen] = useState(false);

  const form = useForm<z.infer<typeof actionSchema>>({
    resolver: zodResolver(actionSchema),
    defaultValues: {
      actionType: "",
      notes: "",
    },
  });

  const onActionSubmit = (data: z.infer<typeof actionSchema>) => {
    if (!selectedAlert) return;
    takeAction.mutate({ id: selectedAlert.id, data }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListAlertsQueryKey({ status: activeTab }) });
        setIsActionModalOpen(false);
        setSelectedAlert(null);
        form.reset();
        toast("Action taken successfully");
      },
      onError: () => {
        toast.error("Failed to take action");
      }
    });
  };

  const handleDismiss = (id: number) => {
    updateStatus.mutate({ id, data: { status: "dismissed" } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListAlertsQueryKey({ status: activeTab }) });
        toast("Alert dismissed");
      }
    });
  };

  const cutoffs = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const week = new Date();
    week.setDate(week.getDate() - 7);
    week.setHours(0, 0, 0, 0);
    return { today, week };
  }, []);

  const allItems = alerts || [];
  const filteredItems = useMemo(() => {
    if (dateRange === "all") return allItems;
    return allItems.filter(a => {
      const d = new Date(a.createdAt);
      if (dateRange === "today") return d >= cutoffs.today;
      return d >= cutoffs.week;
    });
  }, [allItems, dateRange, cutoffs]);

  if (isLoading) return <div className="p-6 space-y-6"><Skeleton className="h-[400px] w-full" /></div>;

  if (isError) {
    return (
      <div className="p-6">
        <QueryError resource="alerts" onRetry={() => refetch()} />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-[1000px] mx-auto">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">System Alerts</h1>
        <div className="flex items-center gap-1 bg-muted rounded-lg p-1">
          {(["all", "week", "today"] as DateRange[]).map(r => (
            <Button
              key={r}
              variant={dateRange === r ? "default" : "ghost"}
              size="sm"
              onClick={() => setDateRange(r)}
              className="h-7 px-3 text-xs capitalize"
            >
              {r === "all" ? "All Time" : r === "week" ? "This Week" : "Today"}
            </Button>
          ))}
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as AlertStatus)} className="w-full">
        <TabsList className="grid w-full grid-cols-3 mb-6">
          <TabsTrigger value="current">Current ({activeTab === "current" ? filteredItems.length : "…"})</TabsTrigger>
          <TabsTrigger value="resolved">Resolved</TabsTrigger>
          <TabsTrigger value="dismissed">Dismissed</TabsTrigger>
        </TabsList>

        <TabsContent value={activeTab} className="space-y-4">
          {filteredItems.length === 0 ? (
            <Card className="shadow-sm border-dashed">
              <CardContent className="flex flex-col items-center justify-center p-12 text-muted-foreground">
                <CheckCircle className="h-12 w-12 mb-4 text-primary/40" />
                <p>No {activeTab} alerts{dateRange !== "all" ? ` in the selected time range` : ""}.</p>
              </CardContent>
            </Card>
          ) : (
            filteredItems.map(alert => (
              <Card key={alert.id} className={`shadow-sm border-l-4 ${alert.severity === "critical" ? "border-l-destructive" : "border-l-status-warn"}`}>
                <CardContent className="p-5 flex flex-col md:flex-row gap-4 justify-between items-start md:items-center">
                  <div className="flex gap-4 flex-1 min-w-0">
                    <div className="mt-1 shrink-0">
                      {alert.severity === "critical" ? (
                        <AlertCircle className="h-5 w-5 text-destructive" />
                      ) : (
                        <AlertTriangle className="h-5 w-5 text-status-warn" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2 mb-1">
                        <h3 className="font-semibold">{alert.title}</h3>
                        <Badge variant={alert.severity === "critical" ? "destructive" : "outline"} className="text-xs uppercase shrink-0">
                          {alert.severity}
                        </Badge>
                        {alert.location && (
                          <Badge variant="outline" className="text-xs text-muted-foreground shrink-0">
                            {alert.location}
                          </Badge>
                        )}
                      </div>
                      <p className="text-sm text-muted-foreground mb-2">{alert.description}</p>
                      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {formatDate(alert.createdAt)}
                        </span>
                        {alert.resolvedAt && (
                          <span className="flex items-center gap-1">
                            <CheckCircle className="h-3 w-3 text-primary" />
                            Resolved: {formatDate(alert.resolvedAt)}
                          </span>
                        )}
                      </div>
                      {alert.actionType && (
                        <div className="mt-3 p-2 bg-muted/50 rounded text-xs border border-border/50">
                          <span className="font-semibold text-foreground">Action taken:</span> {alert.actionType}
                          {alert.actionNotes && <p className="mt-1 text-muted-foreground italic">"{alert.actionNotes}"</p>}
                        </div>
                      )}
                    </div>
                  </div>

                  {activeTab === "current" && (
                    <div className="flex flex-row md:flex-col gap-2 w-full md:w-auto shrink-0">
                      <Dialog
                        open={isActionModalOpen && selectedAlert?.id === alert.id}
                        onOpenChange={(open) => {
                          if (!open) { setIsActionModalOpen(false); setSelectedAlert(null); form.reset(); }
                          else { setIsActionModalOpen(true); setSelectedAlert(alert); }
                        }}
                      >
                        <DialogTrigger asChild>
                          <Button size="sm" className="w-full h-10">Take Action</Button>
                        </DialogTrigger>
                        <DialogContent className="sm:max-w-[480px]">
                          <DialogHeader>
                            <DialogTitle>Take Action on Alert</DialogTitle>
                          </DialogHeader>
                          {/* Alert detail card inside modal */}
                          {selectedAlert && (
                            <div className={`rounded-md border-l-4 p-4 bg-muted/40 ${selectedAlert.severity === "critical" ? "border-l-destructive" : "border-l-status-warn"}`}>
                              <div className="flex items-center gap-2 mb-1">
                                {selectedAlert.severity === "critical" ? (
                                  <AlertCircle className="h-4 w-4 text-destructive shrink-0" />
                                ) : (
                                  <AlertTriangle className="h-4 w-4 text-status-warn shrink-0" />
                                )}
                                <span className="font-semibold text-sm">{selectedAlert.title}</span>
                              </div>
                              <p className="text-xs text-muted-foreground mb-2">{selectedAlert.description}</p>
                              {selectedAlert.location && (
                                <div className="flex items-center gap-2 text-xs">
                                  <Badge variant="outline" className="text-xs">{selectedAlert.location}</Badge>
                                  <span className="flex items-center gap-1 text-muted-foreground">
                                    <CalendarDays className="h-3 w-3" />
                                    {formatDate(selectedAlert.createdAt)}
                                  </span>
                                </div>
                              )}
                            </div>
                          )}
                          <Form {...form}>
                            <form onSubmit={form.handleSubmit(onActionSubmit)} className="space-y-4">
                              <FormField control={form.control} name="actionType" render={({ field }) => (
                                <FormItem><FormLabel>Action Taken</FormLabel>
                                  <Select onValueChange={field.onChange} defaultValue={field.value}>
                                    <FormControl><SelectTrigger><SelectValue placeholder="Select action" /></SelectTrigger></FormControl>
                                    <SelectContent>
                                      <SelectItem value="Maintenance Request">Maintenance Request</SelectItem>
                                      <SelectItem value="Adjusted Settings">Adjusted Settings</SelectItem>
                                      <SelectItem value="Replaced Component">Replaced Component</SelectItem>
                                      <SelectItem value="Notified Team">Notified Team</SelectItem>
                                      <SelectItem value="Scheduled Inspection">Scheduled Inspection</SelectItem>
                                      <SelectItem value="Other">Other</SelectItem>
                                    </SelectContent>
                                  </Select>
                                <FormMessage /></FormItem>
                              )} />
                              <FormField control={form.control} name="notes" render={({ field }) => (
                                <FormItem>
                                  <FormLabel>Notes <span className="text-muted-foreground font-normal">(optional)</span></FormLabel>
                                  <FormControl>
                                    <Textarea {...field} maxLength={200} placeholder="Describe the steps taken..." rows={3} />
                                  </FormControl>
                                  <div className="text-right text-xs text-muted-foreground">{field.value?.length || 0}/200</div>
                                  <FormMessage />
                                </FormItem>
                              )} />
                              <Button type="submit" className="w-full" disabled={takeAction.isPending}>
                                {takeAction.isPending ? "Submitting..." : "Mark as Resolved"}
                              </Button>
                            </form>
                          </Form>
                        </DialogContent>
                      </Dialog>
                      <Button variant="outline" size="sm" className="w-full h-10" onClick={() => handleDismiss(alert.id)}>
                        Dismiss
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

import React, { useState } from "react";
import { useGetBadTraysAnalysis, useCreateBadTrayEntry, getGetBadTraysAnalysisQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { formatNumber, formatCurrency, formatDate } from "@/lib/format";
import { AlertTriangle, Plus, DollarSign, Sprout, Bug, Thermometer, Droplets, Biohazard } from "lucide-react";
import { toast } from "sonner";
import { QueryError } from "@/components/ui/query-error";

const entrySchema = z.object({
  cycleId: z.coerce.number().min(1, "Cycle ID is required"),
  issue: z.string().min(1, "Issue description is required"),
  notes: z.string().optional(),
  fullTrays: z.coerce.number().min(0).optional(),
  halfTrays: z.coerce.number().min(0).optional(),
});

const ISSUE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  Mold: Bug,
  "Root Rot": Droplets,
  Algae: Droplets,
  "Nutrient Burn": Thermometer,
};

function IssueIcon({ issue }: { issue: string }) {
  const Icon = ISSUE_ICONS[issue] ?? Biohazard;
  return <Icon className="h-5 w-5 text-destructive" />;
}

export function BadTrays() {
  const { data: analysis, isLoading, isError, refetch } = useGetBadTraysAnalysis();
  const createEntry = useCreateBadTrayEntry();
  const queryClient = useQueryClient();
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);

  const form = useForm<z.infer<typeof entrySchema>>({
    resolver: zodResolver(entrySchema),
    defaultValues: {
      cycleId: 0,
      issue: "",
      notes: "",
      fullTrays: 1,
      halfTrays: 0,
    },
  });

  const onSubmit = (data: z.infer<typeof entrySchema>) => {
    createEntry.mutate({ data }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetBadTraysAnalysisQueryKey() });
        setIsAddModalOpen(false);
        form.reset();
        toast("Entry added successfully");
      },
      onError: () => {
        toast.error("Failed to add entry");
      }
    });
  };

  if (isLoading) return <div className="p-6 space-y-6"><Skeleton className="h-[400px] w-full" /></div>;

  if (isError) {
    return (
      <div className="p-6">
        <QueryError resource="bad-trays analysis" onRetry={() => refetch()} />
      </div>
    );
  }

  const data = analysis || { totalBadTrays: 0, estimatedLoss: 0, issues: [], manualEntries: [] };
  const topIssues = [...data.issues].sort((a, b) => b.affectedTrays - a.affectedTrays).slice(0, 4);
  const maxAffected = topIssues.reduce((m, i) => Math.max(m, i.affectedTrays), 1);

  return (
    <div className="p-6 space-y-6 max-w-[1400px] mx-auto">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Bad Trays Analysis</h1>
        <Dialog open={isAddModalOpen} onOpenChange={setIsAddModalOpen}>
          <DialogTrigger asChild>
            <Button data-testid="button-add-entry" variant="destructive">
              <Plus className="h-4 w-4 mr-2" />
              Log Bad Trays
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Log Bad Trays Entry</DialogTitle>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <FormField control={form.control} name="cycleId" render={({ field }) => (
                  <FormItem><FormLabel>Cycle ID</FormLabel><FormControl><Input type="number" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="issue" render={({ field }) => (
                  <FormItem><FormLabel>Issue</FormLabel><FormControl><Input placeholder="e.g. Algae, Mold, Root Rot..." {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <div className="grid grid-cols-2 gap-4">
                  <FormField control={form.control} name="fullTrays" render={({ field }) => (
                    <FormItem><FormLabel>Full Trays Affected</FormLabel><FormControl><Input type="number" {...field} /></FormControl><FormMessage /></FormItem>
                  )} />
                  <FormField control={form.control} name="halfTrays" render={({ field }) => (
                    <FormItem><FormLabel>Half Trays Affected</FormLabel><FormControl><Input type="number" {...field} /></FormControl><FormMessage /></FormItem>
                  )} />
                </div>
                <FormField control={form.control} name="notes" render={({ field }) => (
                  <FormItem><FormLabel>Notes <span className="text-muted-foreground font-normal">(optional)</span></FormLabel><FormControl><Textarea {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <Button type="submit" className="w-full" disabled={createEntry.isPending}>
                  {createEntry.isPending ? "Submitting..." : "Log Entry"}
                </Button>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="shadow-sm border-destructive/20 bg-destructive/5">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-destructive">Total Bad Trays</CardTitle>
            <AlertTriangle className="h-4 w-4 text-destructive" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-destructive">{formatNumber(data.totalBadTrays)}</div>
            <p className="text-xs text-destructive/70 mt-1">Across all active cycles</p>
          </CardContent>
        </Card>
        <Card className="shadow-sm border-status-warn/20 bg-status-warn/5">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-status-warn">Estimated Loss</CardTitle>
            <DollarSign className="h-4 w-4 text-status-warn" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-status-warn">{formatCurrency(data.estimatedLoss)}</div>
            <p className="text-xs text-status-warn/70 mt-1">Based on projected yield value</p>
          </CardContent>
        </Card>
      </div>

      {/* Common / Recurring Issues — 2×2 grid */}
      <div>
        <h2 className="text-lg font-semibold tracking-tight mb-3">Common &amp; Recurring Issues</h2>
        {topIssues.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground border rounded-lg border-dashed">
            No issues identified yet.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {topIssues.map((issue, i) => (
              <Card key={i} className="shadow-sm">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <div className="flex items-center gap-2">
                      <div className="p-2 rounded-md bg-destructive/10">
                        <IssueIcon issue={issue.issue} />
                      </div>
                      <div>
                        <h3 className="font-semibold text-sm leading-tight">{issue.issue}</h3>
                        <p className="text-xs text-muted-foreground">{issue.frequency}% of incidents</p>
                      </div>
                    </div>
                    <Badge variant="destructive" className="shrink-0 text-xs">
                      {issue.affectedTrays} trays
                    </Badge>
                  </div>
                  <Progress
                    value={(issue.affectedTrays / maxAffected) * 100}
                    className="h-1.5 mb-3 [&>div]:bg-destructive"
                  />
                  <div className="flex justify-between text-xs text-muted-foreground border-t pt-3">
                    <span>Affected trays: <span className="font-medium text-foreground">{issue.affectedTrays}</span></span>
                    <span>Est. loss: <span className="font-medium text-destructive">{formatCurrency(issue.estimatedLoss)}</span></span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Manual Entries Table */}
      <div>
        <h2 className="text-lg font-semibold tracking-tight mb-3">Recent Manual Entries</h2>
        <Card className="shadow-sm">
          <CardContent className="p-0">
            <div className="rounded-md overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th scope="col" className="p-3 text-left font-medium">Date</th>
                    <th scope="col" className="p-3 text-left font-medium">Tray ID</th>
                    <th scope="col" className="p-3 text-left font-medium">Zone</th>
                    <th scope="col" className="p-3 text-left font-medium">Crop</th>
                    <th scope="col" className="p-3 text-left font-medium">Issue</th>
                    <th scope="col" className="p-3 text-left font-medium">Severity</th>
                  </tr>
                </thead>
                <tbody>
                  {data.manualEntries.map(entry => (
                    <tr key={entry.id} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="p-3 whitespace-nowrap text-muted-foreground">{formatDate(entry.entryDate)}</td>
                      <td className="p-3 font-mono text-xs">{entry.trayId}</td>
                      <td className="p-3 text-muted-foreground">{entry.zone || "—"}</td>
                      <td className="p-3 flex items-center gap-2">
                        <Sprout className="h-3 w-3 text-primary shrink-0" />
                        {entry.cropType}
                      </td>
                      <td className="p-3 font-medium">{entry.issue}</td>
                      <td className="p-3">
                        <Badge
                          variant={entry.severity === "High" ? "destructive" : entry.severity === "Medium" ? "default" : "outline"}
                          className="text-xs"
                        >
                          {entry.severity}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                  {data.manualEntries.length === 0 && (
                    <tr>
                      <td colSpan={6} className="p-8 text-center text-muted-foreground">
                        No manual entries found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

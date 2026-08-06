import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useCreateFacility } from "@workspace/api-client-react";
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";

const farmBasicsSchema = z.object({
  farmName: z.string().min(1, "Farm name is required"),
  facilityName: z.string().optional(),
  timezone: z.string().min(1),
  units: z.enum(["metric", "imperial"]),
  currency: z.string().length(3),
});
type FarmBasicsValues = z.infer<typeof farmBasicsSchema>;

export function FarmBasics({ onSaved }: { onSaved: (data: { facilityId: number; organizationId: number }) => void }) {
  const detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const createFacility = useCreateFacility();

  const form = useForm<FarmBasicsValues>({
    resolver: zodResolver(farmBasicsSchema),
    defaultValues: { farmName: "", facilityName: "", timezone: detectedTz, units: "metric", currency: "USD" },
  });

  const onSubmit = (values: FarmBasicsValues) => {
    createFacility.mutate(
      { data: { ...values, facilityName: values.facilityName || values.farmName } },
      {
        onSuccess: (data) => onSaved(data),
        onError: (err) => {
          // 409 = user already has a facility (double-submit or a stale wizard
          // session) — distinct, actionable message. Anything else: generic
          // failure, matching Inventory.tsx's established toast.error pattern.
          // `err` is `ApiError` at runtime (thrown by custom-fetch.ts on any
          // non-2xx response) but that class is NOT re-exported from
          // "@workspace/api-client-react"'s public index (checked: only
          // setBaseUrl/setAuthTokenGetter/setClientVersion/customFetch and the
          // AuthTokenGetter type are exported) — so duck-type the `status`
          // field instead of importing the class.
          const status =
            typeof err === "object" && err !== null && "status" in err
              ? (err as { status: unknown }).status
              : undefined;
          toast.error(
            status === 409
              ? "You already have a facility set up."
              : "Could not create your facility. Please try again.",
          );
        },
      },
    );
  };

  return (
    <div className="flex justify-center pt-12">
      <Card className="w-[560px] p-8">
        <h1 className="text-2xl font-bold">Tell us about your farm</h1>
        <p className="text-sm text-muted-foreground mt-1">
          This creates your facility. Everything is editable later in Settings.
        </p>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5 mt-6">
            <FormField
              control={form.control}
              name="farmName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Farm name</FormLabel>
                  <FormControl><Input {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="facilityName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Facility name</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder={form.watch("farmName") || undefined} />
                  </FormControl>
                  <p className="text-xs text-muted-foreground">Defaults to your farm name</p>
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="timezone"
              render={({ field }) => (
                <FormItem>
                  <div className="flex items-center gap-2">
                    <FormLabel>Timezone</FormLabel>
                    <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-[hsl(142_40%_96%)] border border-[hsl(142_30%_88%)] text-primary">
                      Auto-detected
                    </span>
                  </div>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                    <SelectContent>
                      <SelectItem value={detectedTz}>{detectedTz}</SelectItem>
                      {/* Confirmed: no shared IANA timezone list exists anywhere in this
                          codebase (checked artifacts/farmeasy and admin-dashboard) — ship
                          with just the auto-detected option for Phase 1. The field is a
                          free-form Select value, not constrained to only the seeded item, and
                          the copy already says "Everything is editable later in Settings" —
                          do not build a full IANA picker here, that's out of scope. */}
                    </SelectContent>
                  </Select>
                </FormItem>
              )}
            />
            <div className="flex gap-4">
              <FormField
                control={form.control}
                name="units"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>Units</FormLabel>
                    <ToggleGroup type="single" value={field.value} onValueChange={(v) => v && field.onChange(v)}>
                      <ToggleGroupItem value="metric">Metric</ToggleGroupItem>
                      <ToggleGroupItem value="imperial">Imperial</ToggleGroupItem>
                    </ToggleGroup>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="currency"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>Currency</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        <SelectItem value="USD">USD</SelectItem>
                        <SelectItem value="CAD">CAD</SelectItem>
                        <SelectItem value="EUR">EUR</SelectItem>
                      </SelectContent>
                    </Select>
                  </FormItem>
                )}
              />
            </div>
            <div className="flex justify-end">
              <Button type="submit" disabled={createFacility.isPending}>
                {createFacility.isPending ? "Creating…" : "Continue →"}
              </Button>
            </div>
          </form>
        </Form>
      </Card>
    </div>
  );
}

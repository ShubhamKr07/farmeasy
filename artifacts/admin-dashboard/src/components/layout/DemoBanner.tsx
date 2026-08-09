import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetDemoStatusQueryKey,
  getListFacilitiesQueryKey,
  usePostDemoGraduate,
} from "@workspace/api-client-react";
import { toast } from "sonner";
import { useDemoStatus } from "@/hooks/use-demo-status";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

/**
 * Persistent, app-wide demo banner (TEN-013 Task 10). Mounted once at the top
 * of `AppLayout`'s chrome so it's visible across every dashboard route. It
 * self-hides (returns `null`) for non-demo users via `useDemoStatus().isDemo`,
 * making it safe and inert to render unconditionally from the layout.
 *
 * For a demo user it shows the escape CTA: "Set up my real farm." Clicking it
 * opens a confirm dialog (graduating deletes the demo facility and every
 * cascaded row under it — destructive enough to warrant an explicit confirm
 * even though the server also requires `confirm:true` in the body). On
 * confirm, `POST /api/demo/graduate` flips `orgs.is_demo` back to false;
 * we then invalidate BOTH the demo-status query (so this banner re-renders
 * hidden) and the facilities query (so `FacilityGate` re-evaluates and routes
 * the now-non-demo, zero-facility user back into the wizard to set up for
 * real). Errors surface as a toast — no silent failure, but no app-blocking
 * modal either.
 *
 * The dialog's open state is local so the user can dismiss it (Cancel) and
 * re-open it without losing the banner itself. `graduating` (the mutation's
 * `isPending`) disables the confirm button and shows a spinner while the
 * POST is in flight, and disables the dialog's close affordances implicitly.
 */
export function DemoBanner() {
  const { isDemo } = useDemoStatus();
  const queryClient = useQueryClient();
  const graduate = usePostDemoGraduate();
  const [open, setOpen] = useState(false);

  // Self-hide for non-demo users (and before the status query resolves —
  // `isDemo` defaults to false while loading, so a real demo user sees this
  // banner appear as soon as the GET lands, with no false-positive flash for
  // the far more common non-demo case).
  if (!isDemo) return null;

  const handleConfirm = async () => {
    try {
      await graduate.mutateAsync({ data: { confirm: true } });
      // Invalidate both queries: demo-status so this banner hides itself on
      // the next render, and facilities so FacilityGate (App.tsx) re-runs its
      // routing with the now-deleted demo facility removed from the list
      // (the graduated org has zero facilities, so the user re-enters the
      // wizard to set up their real farm).
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getGetDemoStatusQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getListFacilitiesQueryKey() }),
      ]);
      setOpen(false);
    } catch {
      toast.error("Could not set up your real farm. Please try again.");
    }
  };

  return (
    <div className="flex items-center justify-between gap-3 border-b border-primary-border bg-primary/10 px-4 py-2 text-sm">
      <span className="text-foreground">
        You're exploring a demo — your data here is sample data.
      </span>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogTrigger asChild>
          <Button size="sm">Set up my real farm</Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Set up your real farm?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the demo facility and all its sample data, then takes you
              through farm setup from scratch. You can't undo this.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={graduate.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={graduate.isPending}
              onClick={(e) => {
                // Prevent the radix action's default close-on-click so the
                // dialog stays open (with a spinner) until the async graduate
                // resolves; we close it explicitly in handleConfirm.
                e.preventDefault();
                void handleConfirm();
              }}
            >
              {graduate.isPending && <Spinner className="mr-2" />}
              {graduate.isPending ? "Setting up…" : "Set up real farm"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

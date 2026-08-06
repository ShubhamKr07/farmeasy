import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListMembers,
  getListMembersQueryKey,
  useListInvitations,
  getListInvitationsQueryKey,
  useCreateInvitation,
  useRevokeInvitation,
  useChangeMemberRole,
  useRemoveMember,
  type Member,
  type Invitation,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Users } from "lucide-react";

/** Invitable roles — owner is creator-only and never offered (TEN-010). */
type InviteRole = "admin" | "technician";

const ROLE_OPTIONS: { value: InviteRole; label: string }[] = [
  { value: "admin", label: "Admin" },
  { value: "technician", label: "Technician" },
];

function roleLabel(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

/**
 * Duck-types a mutation error's `status`/`data` fields into a user-facing
 * inline message for the invite form. `ApiError` (thrown by custom-fetch on
 * any non-2xx) carries `status: number` and `data` (the parsed body), but
 * that class is NOT re-exported from `@workspace/api-client-react`'s public
 * index — so read the shape directly rather than importing a type, exactly
 * as `FarmBasics.tsx` does for its 409 case. Covers the documented
 * `POST /invitations` 400 ("already belongs to an organization" / other
 * validation) and 403 (ROLE_FORBIDDEN — insufficient role) cases.
 */
function describeInviteError(err: unknown): string {
  const status =
    typeof err === "object" && err !== null && "status" in err
      ? (err as { status: unknown }).status
      : undefined;
  const body =
    typeof err === "object" && err !== null && "data" in err
      ? (err as { data: unknown }).data
      : undefined;
  const apiMessage =
    body && typeof body === "object" && body !== null && "error" in body
      ? String((body as { error: unknown }).error)
      : undefined;

  if (status === 403) {
    return "You don't have permission to send invites. Only owners and admins can invite members.";
  }
  if (status === 400) {
    // The server's "already belongs to an organization" (and any other
    // validation) message is specific and actionable — surface it verbatim;
    // fall back to a generic 400 hint only if the body was empty.
    if (apiMessage) return apiMessage;
    return "That email can't be invited. Check the address and try again.";
  }
  return "Couldn't send the invitation. Please try again.";
}

export function TeamSection() {
  const queryClient = useQueryClient();
  const members = useListMembers();
  const invitations = useListInvitations();
  const createInvitation = useCreateInvitation();
  const revokeInvitation = useRevokeInvitation();
  const changeRole = useChangeMemberRole();
  const removeMember = useRemoveMember();

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InviteRole>("technician");
  const [submitError, setSubmitError] = useState<string | null>(null);

  const handleInvite = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSubmitError(null);
    createInvitation.mutate(
      { data: { email: email.trim(), role } },
      {
        onSuccess: () => {
          setEmail("");
          setRole("technician");
          toast.success("Invitation sent");
          void queryClient.invalidateQueries({ queryKey: getListInvitationsQueryKey() });
        },
        onError: (err) => {
          const message = describeInviteError(err);
          setSubmitError(message);
          // Still surface a toast — the codebase convention for mutation
          // failures (Inventory.tsx). The inline message above is the
          // required, primary signal.
          toast.error(message);
        },
      },
    );
  };

  const handleRevoke = (invitation: Invitation) => {
    revokeInvitation.mutate(
      { id: invitation.id },
      {
        onSuccess: () => {
          toast.success("Invitation revoked");
          void queryClient.invalidateQueries({ queryKey: getListInvitationsQueryKey() });
        },
        onError: () => toast.error("Couldn't revoke the invitation"),
      },
    );
  };

  const handleRoleChange = (member: Member, next: InviteRole) => {
    changeRole.mutate(
      { userId: member.userId, data: { role: next } },
      {
        onSuccess: () => {
          toast.success(`${member.email} is now ${roleLabel(next)}`);
          void queryClient.invalidateQueries({ queryKey: getListMembersQueryKey() });
        },
        onError: () => toast.error("Couldn't change the role"),
      },
    );
  };

  const handleRemove = (member: Member) => {
    if (
      !window.confirm(
        `Remove ${member.email} from the team? They'll lose access immediately.`,
      )
    ) {
      return;
    }
    removeMember.mutate(
      { userId: member.userId },
      {
        onSuccess: () => {
          toast.success("Member removed");
          void queryClient.invalidateQueries({ queryKey: getListMembersQueryKey() });
        },
        onError: () => toast.error("Couldn't remove the member"),
      },
    );
  };

  return (
    <Card className="shadow-sm max-w-2xl">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">Team</CardTitle>
        <Users className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Members */}
        <section className="space-y-2">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Members
          </h3>
          {members.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : members.data && members.data.length > 0 ? (
            <ul className="divide-y divide-border">
              {members.data.map((member) => (
                <li
                  key={member.userId}
                  className="flex items-center justify-between gap-3 py-2"
                >
                  <span className="text-sm truncate" title={member.email}>
                    {member.email}
                  </span>
                  {member.role === "owner" ? (
                    // Owner is creator-only, non-assignable, non-removable in
                    // v1 — render static text, NO role Select, NO Remove
                    // button. The server also rejects these ops, but the UI
                    // must never offer them.
                    <span className="text-xs text-muted-foreground font-medium">
                      Owner
                    </span>
                  ) : (
                    <div className="flex items-center gap-2">
                      <Select
                        value={member.role}
                        onValueChange={(v) => handleRoleChange(member, v as InviteRole)}
                      >
                        <SelectTrigger className="h-8 w-[130px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ROLE_OPTIONS.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value}>
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 text-muted-foreground hover:text-destructive"
                        onClick={() => handleRemove(member)}
                        disabled={removeMember.isPending}
                      >
                        Remove
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No members.</p>
          )}
        </section>

        {/* Pending invites */}
        <section className="space-y-2">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Pending invites
          </h3>
          {invitations.isLoading ? (
            <Skeleton className="h-9 w-full" />
          ) : invitations.data && invitations.data.length > 0 ? (
            <ul className="divide-y divide-border">
              {invitations.data.map((invitation) => (
                <li
                  key={invitation.id}
                  className="flex items-center justify-between gap-3 py-2"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm truncate" title={invitation.email}>
                      {invitation.email}
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {roleLabel(invitation.role)}
                    </span>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 text-muted-foreground hover:text-destructive shrink-0"
                    onClick={() => handleRevoke(invitation)}
                    disabled={revokeInvitation.isPending}
                  >
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No pending invites.</p>
          )}
        </section>

        {/* Invite form */}
        <form onSubmit={handleInvite} className="space-y-3 pt-2 border-t border-border">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Invite a member
          </h3>
          <div className="flex flex-col sm:flex-row gap-2">
            <Input
              type="email"
              required
              placeholder="email@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="flex-1"
            />
            <Select
              value={role}
              onValueChange={(v) => setRole(v as InviteRole)}
            >
              <SelectTrigger className="h-9 sm:w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="submit" disabled={createInvitation.isPending}>
              {createInvitation.isPending ? "Sending…" : "Send invite"}
            </Button>
          </div>
          {submitError && <p className="text-sm text-destructive">{submitError}</p>}
        </form>
      </CardContent>
    </Card>
  );
}

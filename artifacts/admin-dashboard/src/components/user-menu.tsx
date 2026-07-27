import React from "react";
import { useLocation } from "wouter";
import { useSupabaseSession } from "@/hooks/use-supabase-session";
import { supabase } from "@/lib/supabase";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { User, Settings as SettingsIcon, LogOut } from "lucide-react";

/**
 * TopBar user menu. Backed by Supabase Auth — shows the signed-in user's
 * avatar/name and a working sign-out. Profile/Settings navigate via wouter.
 */
export function UserMenu() {
  const [, navigate] = useLocation();
  const { session, loading } = useSupabaseSession();

  const user = session?.user;
  const meta = (user?.user_metadata ?? {}) as Record<string, string | undefined>;
  const name = meta.full_name ?? meta.name ?? "Operator";
  const email = user?.email ?? undefined;
  const initials = (
    (meta.full_name?.[0] ?? meta.name?.[0] ?? (user?.email?.[0] ?? ""))
  ).toUpperCase() || "O";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="h-10 w-10 rounded-full inline-flex items-center justify-center hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="User menu"
          data-testid="button-user-menu"
        >
          <Avatar className="h-8 w-8">
            {!loading && (meta.avatar_url ?? meta.picture) ? (
              <AvatarImage src={meta.avatar_url ?? meta.picture} alt={name} />
            ) : null}
            <AvatarFallback className="bg-primary/10 text-primary text-xs font-semibold">
              {initials}
            </AvatarFallback>
          </Avatar>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel className="flex flex-col">
          <span className="font-medium text-sm truncate">{name}</span>
          {email && (
            <span className="text-xs text-muted-foreground font-normal truncate">
              {email}
            </span>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => navigate("/profile")}>
          <User className="mr-2 h-4 w-4" />
          Profile
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => navigate("/settings")}>
          <SettingsIcon className="mr-2 h-4 w-4" />
          Settings
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => supabase.auth.signOut()}>
          <LogOut className="mr-2 h-4 w-4" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

alter table public.users enable row level security;

create policy "users can read their own row"
  on public.users for select
  using (auth.uid() = id);

create policy "users can update their own row (not role)"
  on public.users for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Missing entirely from the original migration -- caught live during
-- sign-up e2e testing: app/(auth)/sign-up.tsx self-inserts a public.users
-- row immediately after supabase.auth.signUp() succeeds (see Task 7's
-- plan notes), using the anon-key client as the newly-authenticated user.
-- With no INSERT policy, every real sign-up failed with "new row violates
-- row-level security policy for table \"users\"" -- SELECT and UPDATE
-- policies alone don't cover the row's creation.
create policy "users can insert their own row"
  on public.users for insert
  with check (auth.uid() = id);

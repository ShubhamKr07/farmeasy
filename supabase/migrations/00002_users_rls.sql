alter table public.users enable row level security;

create policy "users can read their own row"
  on public.users for select
  using (auth.uid() = id);

create policy "users can update their own row (not role)"
  on public.users for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

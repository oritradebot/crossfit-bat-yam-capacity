-- 10/09/2026 — deploy 6: client error reports. Ori runs this ONCE in
-- Supabase → SQL Editor → New query → Run. Also in supabase/schema.sql. Safe to re-run.

-- ============================================================
--  CLIENT ERROR REPORTS (deploy 6, 10/09/2026) — what breaks on athletes'
--  phones. boot.js inserts its OWN rows (uncaught errors, unhandled
--  rejections, sync failures while online, dead localStorage, missing
--  interceptor), capped per page session; the admin panel's 🩺 view lists
--  the last 50 and can clear them. No FK-free archive needed: rows die with
--  the account. Until this runs, the client insert fails silently.
-- ============================================================
create table if not exists public.client_errors (
  id         bigserial primary key,
  user_id    uuid references auth.users(id) on delete cascade,
  build      text,
  kind       text not null,          -- error | rejection | sync | localfail | nointercept
  message    text not null,
  detail     text,
  ua         text,
  created_at timestamptz not null default now()
);
create index if not exists client_errors_created_idx on public.client_errors (created_at desc);
alter table public.client_errors enable row level security;
drop policy if exists client_errors_insert on public.client_errors;
create policy client_errors_insert on public.client_errors for insert to authenticated
  with check (user_id = auth.uid());
drop policy if exists client_errors_admin on public.client_errors;
create policy client_errors_admin on public.client_errors for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

notify pgrst, 'reload schema';

-- verify: expect 0 rows and no error
select count(*) from public.client_errors;

-- ============================================================
--  BAT YAM Capacity Tracker — Supabase schema
--  Run this once in  Supabase → SQL Editor → New query → Run.
-- ============================================================

-- 1) PROFILES : one row per user (name shown on the board, admin flag)
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  name       text not null default '',
  is_admin   boolean not null default false,
  created_at timestamptz not null default now()
);

-- 2) STATES : each user's full tracker blob (program + their own results)
create table if not exists public.states (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  tracker    jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- 3) BOARD : shared leaderboard — everyone can read everyone
create table if not exists public.board (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  name       text not null default '',
  results    jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- 4) SHARED_PROGRAM : single row (id=1) — the admin-authored 8-week program
create table if not exists public.shared_program (
  id         int primary key default 1,
  weeks      jsonb,
  updated_at timestamptz not null default now(),
  constraint one_row check (id = 1)
);
insert into public.shared_program (id, weeks) values (1, null)
  on conflict (id) do nothing;

-- ============================================================
--  ROW LEVEL SECURITY
-- ============================================================
alter table public.profiles       enable row level security;
alter table public.states         enable row level security;
alter table public.board          enable row level security;
alter table public.shared_program enable row level security;

-- PROFILES: a user reads/writes only their own row; everyone may read names
drop policy if exists profiles_read  on public.profiles;
drop policy if exists profiles_write on public.profiles;
create policy profiles_read  on public.profiles for select to authenticated using (true);
create policy profiles_write on public.profiles for all    to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- STATES: strictly private to the owner
drop policy if exists states_owner on public.states;
create policy states_owner on public.states for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- BOARD: everyone reads all; each user writes only their own row
drop policy if exists board_read  on public.board;
drop policy if exists board_write on public.board;
create policy board_read  on public.board for select to authenticated using (true);
create policy board_write on public.board for all    to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- SHARED_PROGRAM: everyone reads; only an admin may write
drop policy if exists prog_read  on public.shared_program;
drop policy if exists prog_write on public.shared_program;
create policy prog_read  on public.shared_program for select to authenticated using (true);
create policy prog_write on public.shared_program for all to authenticated
  using (  exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin) )
  with check ( exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin) );

-- ============================================================
--  AFTER you sign up with YOUR email, make yourself admin:
--  update public.profiles set is_admin = true where id =
--     (select id from auth.users where email = 'YOUR-EMAIL');
-- ============================================================

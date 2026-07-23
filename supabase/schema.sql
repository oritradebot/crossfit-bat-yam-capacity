-- ============================================================
--  BAT YAM Capacity Tracker — Supabase schema
--  Run this once in  Supabase → SQL Editor → New query → Run.
-- ============================================================

-- 1) PROFILES : one row per user (name shown on the board, admin flag)
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  name         text not null default '',
  email        text,                          -- the plain username (shown in the admin panel)
  is_admin     boolean not null default false,
  welcome_seen boolean not null default false,
  gender       text,                          -- 'male' | 'female' (competition category)
  birth_date   date,                          -- category is derived from age
  created_at   timestamptz not null default now()
);
-- keep existing installs in sync (columns added after the first launch)
alter table public.profiles add column if not exists email        text;
alter table public.profiles add column if not exists welcome_seen boolean not null default false;
alter table public.profiles add column if not exists gender       text;
alter table public.profiles add column if not exists birth_date   date;

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
  weeks      jsonb,                            -- per-week summary: [{completed, result}, ...]
  updated_at timestamptz not null default now()
);
-- keep existing installs in sync
alter table public.board add column if not exists weeks jsonb;
-- per-metcon comparable results for the RX ranking engine:
-- { "w_d": { v, dir, rx }, ... } keyed by week_day (+ _2/_a/_a2 variants)
alter table public.board add column if not exists metcons jsonb;

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

-- Admin check as a SECURITY DEFINER function so an admin policy on `profiles`
-- can look at `profiles` without triggering RLS recursion.
create or replace function public.is_admin()
  returns boolean
  language sql
  security definer
  stable
  set search_path = public
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and is_admin);
$$;

-- Fully delete a user (admin-only). Removing the auth.users row cascades to
-- profiles/states/board via their on-delete-cascade FKs, so the person can no
-- longer sign in — unlike client-side deletes which leave the auth account.
create or replace function public.admin_delete_user(target uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public, auth
as $$
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  if target = auth.uid() then raise exception 'cannot delete yourself'; end if;
  delete from auth.users where id = target;
end;
$$;

-- Drop any legacy admin policies that used an INLINE "select ... from profiles"
-- subquery. Such a policy on `profiles` causes RLS infinite-recursion the moment
-- the table is read. The is_admin() helper above replaces all of them.
drop policy if exists profile_admin_del    on public.profiles;
drop policy if exists profiles_admin_write on public.profiles;
drop policy if exists states_admin_del     on public.states;
drop policy if exists states_admin_read    on public.states;
drop policy if exists board_admin_del      on public.board;

-- PROFILES: a user reads/writes only their own row; everyone may read names.
-- Admins may create/edit/delete any profile (needed by the admin panel).
drop policy if exists profiles_read  on public.profiles;
drop policy if exists profiles_write on public.profiles;
drop policy if exists profiles_admin on public.profiles;
create policy profiles_read  on public.profiles for select to authenticated using (true);
create policy profiles_write on public.profiles for all    to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
create policy profiles_admin on public.profiles for all    to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- STATES: private to the owner; admins may read/delete any row (admin panel).
drop policy if exists states_owner on public.states;
drop policy if exists states_admin on public.states;
create policy states_owner on public.states for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy states_admin on public.states for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- BOARD: everyone reads all; each user writes only their own row;
-- admins may delete any row (removing a user from the panel).
drop policy if exists board_read  on public.board;
drop policy if exists board_write on public.board;
drop policy if exists board_admin on public.board;
create policy board_read  on public.board for select to authenticated using (true);
create policy board_write on public.board for all    to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy board_admin on public.board for all    to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- SHARED_PROGRAM: everyone reads; only an admin may write
drop policy if exists prog_read  on public.shared_program;
drop policy if exists prog_write on public.shared_program;
create policy prog_read  on public.shared_program for select to authenticated using (true);
create policy prog_write on public.shared_program for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ============================================================
--  AFTER you sign up with YOUR email, make yourself admin:
--  update public.profiles set is_admin = true where id =
--     (select id from auth.users where email = 'YOUR-EMAIL');
-- ============================================================

-- ============================================================
--  10/09/2026 — privilege guard + privacy (decided with Ori in the
--  improvement questionnaire; see docs/roadmap.md §9).
--  Ori runs this ONCE in Supabase → SQL Editor → New query → Run.
--  Everything here is also in supabase/schema.sql. Safe to re-run.
-- ============================================================

-- 0) BEFORE — only Ori should be true.
select name, email, is_admin from public.profiles order by is_admin desc, name;

-- 1) is_admin becomes read-only for API callers who are not already admins.
--    Closes the hole where a member could PATCH their own profile row with
--    {"is_admin": true}: RLS cannot restrict columns, and profiles_write lets
--    a user update every column of their own row. The SQL editor (role
--    postgres), service_role and the auth signup trigger are not affected.
create or replace function public.guard_profile_flags()
  returns trigger
  language plpgsql
  set search_path = public
as $$
begin
  if current_user in ('anon', 'authenticated') and not public.is_admin() then
    if tg_op = 'INSERT' and coalesce(new.is_admin, false) then
      raise exception 'is_admin is read-only';
    end if;
    if tg_op = 'UPDATE' and new.is_admin is distinct from old.is_admin then
      raise exception 'is_admin is read-only';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists profiles_guard_flags on public.profiles;
create trigger profiles_guard_flags
  before insert or update on public.profiles
  for each row execute function public.guard_profile_flags();

-- 2) profiles: a member reads only their own row; admins read all.
--    (Was "everyone may read names" — a leftover of the shared leaderboard.
--    The app reads only its own row; the admin panel reads all as admin.)
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());

-- 3) Still pending from v3 (07/09): the board row is private to its owner + admins.
drop policy if exists board_read on public.board;
create policy board_read on public.board for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- 4) Still pending from v3 (07/09): goal columns (the goal card syncs once they exist).
alter table public.profiles add column if not exists goal         text;
alter table public.profiles add column if not exists goal_done_at timestamptz;

notify pgrst, 'reload schema';

-- 5) AFTER — expect one trigger row and the two new read policies.
select tgname, tgenabled from pg_trigger
 where tgrelid = 'public.profiles'::regclass and not tgisinternal;
select tablename, policyname, cmd, qual from pg_policies
 where tablename in ('profiles', 'board') order by tablename, policyname;
select name, email, is_admin from public.profiles order by is_admin desc, name;

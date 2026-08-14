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
-- id of the last block announcement this user saw (popup shows once per user)
alter table public.profiles add column if not exists announcement_seen text;

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
-- public profile summary each user publishes about themselves (viewable by all):
-- { t: total workouts, s: best streak, p: PR count, rx: RX metcons,
--   r9: RPE9+ sessions, fw: full weeks, prs: [last 3 {move,res,week}] }
alter table public.board add column if not exists pub jsonb;

-- 4) SHARED_PROGRAM : single row (id=1) — the admin-authored 8-week program
create table if not exists public.shared_program (
  id         int primary key default 1,
  weeks      jsonb,
  updated_at timestamptz not null default now(),
  constraint one_row check (id = 1)
);
insert into public.shared_program (id, weeks) values (1, null)
  on conflict (id) do nothing;
-- block announcement the admin publishes with a new block:
-- { id, title, body, created_at } — popup shows once per user (see
-- profiles.announcement_seen). NULL = no active announcement, nothing pops.
alter table public.shared_program add column if not exists announcement jsonb;
-- append-only log of every announcement ever published — the admin's audit
-- trail ("what did I send and when"), shown in the admin panel's 📜 view:
-- [{ id, title, body, created_at, removed_at? }, ...] oldest-first.
-- removed_at appears only when an active message was taken down early.
alter table public.shared_program add column if not exists announcement_log jsonb;

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
-- Dropped first: CREATE OR REPLACE fails if an older copy exists with a
-- different parameter name, and re-running this file must always heal the RPC.
drop function if exists public.admin_delete_user(uuid);
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

-- Set a user's password (admin-only) — for members who forgot theirs.
-- Passwords live only as bcrypt hashes in auth.users, so "viewing" an existing
-- password is impossible by design; the admin assigns a NEW one instead.
-- Old refresh tokens are revoked so any leftover session dies with the reset.
create extension if not exists pgcrypto with schema extensions;
drop function if exists public.admin_set_password(uuid, text);
create or replace function public.admin_set_password(target uuid, new_password text)
  returns void
  language plpgsql
  security definer
  set search_path = public, auth, extensions
as $$
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  if length(new_password) < 6 then raise exception 'password too short'; end if;
  update auth.users
     set encrypted_password = crypt(new_password, gen_salt('bf')),
         updated_at = now()
   where id = target;
  if not found then raise exception 'user not found'; end if;
  delete from auth.refresh_tokens where user_id = target::varchar;
end;
$$;

-- Close-time sync channel (v1.7.3): merge ONLY the days written this session
-- into the caller's states blob. The browser hard-caps keepalive bodies at
-- 64KB and the full tracker blob is ~71KB, so the push that fires when the
-- app closes failed for everyone, silently, on every close — a workout logged
-- right before closing survived only via localStorage recovery, which a dead
-- iOS localStorage (the 27/07 incident) turned into permanent loss. A few
-- days are ~2KB and always fit. Day-level last-writer-wins via the same
-- "last touched" stamps (tracker._dts) the client merge uses, so a stale
-- device can never clobber a newer day through this path.
-- SECURITY: invoker rights — RLS (states_owner) applies, and the function
-- only ever touches auth.uid()'s own row.
drop function if exists public.push_days(jsonb, jsonb);
create or replace function public.push_days(p_days jsonb, p_dts jsonb)
  returns jsonb
  language plpgsql
  security invoker
  set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_tracker jsonb;
  v_key     text;
  v_day     jsonb;
  v_w       int;
  v_d       int;
  v_new     numeric;
  v_cur     numeric;
  v_applied int := 0;
  v_skipped int := 0;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  if p_days is null or jsonb_typeof(p_days) <> 'object' then
    return jsonb_build_object('status', 'badinput');
  end if;

  select tracker into v_tracker
    from public.states
   where user_id = v_uid
     for update;

  -- No row yet (or a blob with no program): do NOT create one here. A fresh
  -- scaffold born from a close-time push is exactly the "empty shell beats
  -- real data" family of bugs — the client's next full push creates the row.
  if v_tracker is null or jsonb_typeof(v_tracker->'weeks') <> 'array' then
    return jsonb_build_object('status', 'norow');
  end if;

  if v_tracker->'_dts' is null or jsonb_typeof(v_tracker->'_dts') <> 'object' then
    v_tracker := jsonb_set(v_tracker, '{_dts}', '{}'::jsonb, true);
  end if;

  for v_key, v_day in select key, value from jsonb_each(p_days) loop
    begin
      v_w := split_part(v_key, '_', 1)::int;
      v_d := split_part(v_key, '_', 2)::int;
    exception when others then
      v_skipped := v_skipped + 1;
      continue;
    end;
    -- Sane bounds; also keeps negative jsonb indexes (count-from-the-end)
    -- from ever being addressed.
    if v_w < 0 or v_w > 51 or v_d < 0 or v_d > 6 then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    v_new := coalesce(nullif(p_dts->>v_key, '')::numeric, 0);
    v_cur := coalesce(nullif(v_tracker->'_dts'->>v_key, '')::numeric, 0);
    -- Day-level last-writer-wins (same rule as the client merge). The slot
    -- must already exist: a structurally missing day means the server blob
    -- predates this program version, and the day will arrive with the next
    -- full push instead.
    if v_new >= v_cur
       and jsonb_typeof(v_day) = 'object'
       and jsonb_typeof(v_tracker->'weeks'->v_w) = 'object'
       and jsonb_typeof(v_tracker->'weeks'->v_w->'days'->v_d) = 'object' then
      v_tracker := jsonb_set(v_tracker, array['weeks', v_w::text, 'days', v_d::text], v_day, false);
      v_tracker := jsonb_set(v_tracker, array['_dts', v_key], to_jsonb(v_new), true);
      v_applied := v_applied + 1;
    else
      v_skipped := v_skipped + 1;
    end if;
  end loop;

  if v_applied > 0 then
    update public.states
       set tracker    = v_tracker,
           updated_at = now()
     where user_id = v_uid;
  end if;

  return jsonb_build_object('status', 'ok', 'applied', v_applied, 'skipped', v_skipped);
end;
$$;

revoke all on function public.push_days(jsonb, jsonb) from public;
revoke all on function public.push_days(jsonb, jsonb) from anon;
grant execute on function public.push_days(jsonb, jsonb) to authenticated;

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

-- PostgREST caches the schema; without this, a just-created function keeps
-- returning "Could not find the function ... in the schema cache" for a while.
notify pgrst, 'reload schema';

-- ============================================================
--  AFTER you sign up with YOUR email, make yourself admin:
--  update public.profiles set is_admin = true where id =
--     (select id from auth.users where email = 'YOUR-EMAIL');
-- ============================================================

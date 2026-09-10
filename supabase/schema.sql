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
-- v3 (07/09/2026) goal card: the athlete's own goal + when they marked it
-- reached. On the person, not the block — a block reset never touches it.
-- (To run by hand on the live DB per the schema-drift workflow; until then
-- boot.js keeps the goal on the device and retries once the columns exist.)
alter table public.profiles add column if not exists goal         text;
alter table public.profiles add column if not exists goal_done_at timestamptz;
-- v3 (07/09/2026) PR ledger: the athlete's best lift per movement (+ the
-- days they flagged 🏆) from EARLIER blocks. Written by the admin panel's
-- "🧨 איפוס בלוק" right before it deletes states (profiles survive a reset);
-- the app shows a carried record as "BLOCK I" until the current block beats
-- it. Tests are not records and are not kept. Shape: { v, lifts:{key:{move,
-- best, reps, week, block}}, flags:[{key, move, res, week, block}] }.
-- (Run by hand on the live DB BEFORE the block-1 reset; with the column
-- missing the panel stops before deleting anything.)
alter table public.profiles add column if not exists prs          jsonb;

-- 2) STATES : each user's full tracker blob (program + their own results)
create table if not exists public.states (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  tracker    jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- 3) BOARD : per-user summary row (v3) — read by its owner + admins (was the shared leaderboard)
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
--   hard: sessions rated 'hard' (v3 effort scale), fw: full weeks, prs: [last 3 {move,res,week}] }
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
-- block-recap gate (v2.1.0): { open: true, opened_at } when the admin opened
-- the end-of-block share card to the roster. NULL / missing / open !== true
-- all read as closed — a gate that fails open is not a gate. Admins always
-- see a labeled preview of their own card regardless of this flag.
-- (Ran by hand on the live DB 29/08/2026, per the schema-drift workflow.)
alter table public.shared_program add column if not exists block_recap jsonb;

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

-- PROFILES: a user reads/writes only their own row; admins read all.
-- (10/09/2026: was "everyone may read names" — a leftover of the shared
-- leaderboard. The app reads only its own row; the panel reads all as admin.)
-- Admins may create/edit/delete any profile (needed by the admin panel).
drop policy if exists profiles_read  on public.profiles;
drop policy if exists profiles_write on public.profiles;
drop policy if exists profiles_admin on public.profiles;
create policy profiles_read  on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());
create policy profiles_write on public.profiles for all    to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
create policy profiles_admin on public.profiles for all    to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- is_admin is READ-ONLY for API callers who are not already admins
-- (10/09/2026). RLS cannot restrict columns: profiles_write lets a user
-- update every column of their own row, so one PATCH with {"is_admin": true}
-- used to make any member an admin (read everyone, delete users, reset the
-- block). The SQL editor (role postgres), service_role and the auth signup
-- trigger are not affected — "make yourself admin" from the README still works.
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
-- v3 (07/09/2026): the board table is a per-user summary row, not a shared
-- leaderboard any more — only its owner and admins may read it. The app has
-- fetched only its own row since v3 phase 1; the admin panel reads them all.
-- (To run by hand on the live DB after the phase-1 deploy, per the
-- schema-drift workflow.)
create policy board_read  on public.board for select to authenticated
  using (user_id = auth.uid() or public.is_admin());
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
--  BLOCK RESET (v2.3.0) — archive, then wipe. One transaction, admin only.
-- ============================================================
-- block_archive keeps every states/board row (plus the shared_program row) as
-- it was the moment a block was reset, under the label the admin typed
-- ("block-1", "block-2-tests", ...). No FK to auth.users on purpose: the
-- archive must survive a member being deleted later. Admin-only through RLS.
-- (Not yet run on the live DB — see the journal's SQL section.)
create table if not exists public.block_archive (
  id          bigserial primary key,
  label       text not null,
  kind        text not null check (kind in ('states','board','program')),
  user_id     uuid,                              -- null for the program row
  name        text not null default '',          -- member's name at archive time
  data        jsonb not null,
  archived_at timestamptz not null default now()
);
create index if not exists block_archive_label_idx on public.block_archive (label, kind);
alter table public.block_archive enable row level security;
drop policy if exists archive_admin on public.block_archive;
create policy archive_admin on public.block_archive for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- The admin panel's "🧨 איפוס בלוק" button calls this. Copies states + board
-- (+ the shared_program row) into block_archive, deletes states + board, and
-- resets shared_program (weeks, block_recap, announcement — announcement_log
-- is KEPT: it is the admin's audit trail). Everything in ONE transaction: a
-- failure anywhere leaves the data exactly as it was. Accounts, profiles and
-- every table survive — "reset the data, not the infrastructure" (Ori, 06/09).
drop function if exists public.admin_reset_block(text);
create or replace function public.admin_reset_block(p_label text)
  returns jsonb
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_as int := 0;
  v_ab int := 0;
  v_ds int := 0;
  v_db int := 0;
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  if p_label is null or length(trim(p_label)) = 0 then raise exception 'label required'; end if;

  insert into public.block_archive (label, kind, user_id, name, data)
    select p_label, 'states', s.user_id, coalesce(p.name, ''),
           jsonb_build_object('tracker', s.tracker, 'updated_at', s.updated_at)
      from public.states s
      left join public.profiles p on p.id = s.user_id;
  get diagnostics v_as = row_count;

  insert into public.block_archive (label, kind, user_id, name, data)
    select p_label, 'board', b.user_id, coalesce(p.name, b.name, ''), to_jsonb(b)
      from public.board b
      left join public.profiles p on p.id = b.user_id;
  get diagnostics v_ab = row_count;

  insert into public.block_archive (label, kind, user_id, name, data)
    select p_label, 'program', null, '', to_jsonb(sp)
      from public.shared_program sp
     where sp.id = 1;

  -- PostgREST connections run with pg-safeupdate loaded: a DELETE with no
  -- WHERE clause is refused even inside a function ("DELETE requires a
  -- WHERE clause", seen on the first live reset 07/09/2026). WHERE TRUE
  -- satisfies it and still deletes every row.
  delete from public.states where true;
  get diagnostics v_ds = row_count;
  delete from public.board where true;
  get diagnostics v_db = row_count;

  update public.shared_program
     set weeks = null, block_recap = null, announcement = null, updated_at = now()
   where id = 1;

  return jsonb_build_object('archived_states', v_as, 'archived_board', v_ab,
                            'deleted_states', v_ds, 'deleted_board', v_db,
                            'label', p_label);
end;
$$;

revoke all on function public.admin_reset_block(text) from public;
revoke all on function public.admin_reset_block(text) from anon;
grant execute on function public.admin_reset_block(text) to authenticated;

-- PostgREST caches the schema; without this, a just-created function keeps
-- returning "Could not find the function ... in the schema cache" for a while.
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

-- ============================================================
--  AFTER you sign up with YOUR email, make yourself admin:
--  update public.profiles set is_admin = true where id =
--     (select id from auth.users where email = 'YOUR-EMAIL');
-- ============================================================

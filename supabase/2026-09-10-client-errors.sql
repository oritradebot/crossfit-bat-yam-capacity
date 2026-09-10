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

-- ============================================================
-- 7) ADMIN AUDIT LOG (deploy 7) — table + the three admin RPCs re-created so
--    they write a row (bodies identical to schema.sql).
-- ============================================================
-- ============================================================
--  ADMIN AUDIT LOG (deploy 7, 10/09/2026) — who did what, when. The three
--  admin RPCs write their own rows (delete_user / set_password / reset_block,
--  as SECURITY DEFINER they bypass RLS); the panel writes restore / recap gate
--  / add_user directly (admin-only insert policy). Read in the panel's 🩺 view.
--  No FK to auth.users on purpose: the trail must survive a deleted account.
-- ============================================================
create table if not exists public.admin_audit (
  id          bigserial primary key,
  admin_id    uuid,
  action      text not null,          -- delete_user | set_password | reset_block | restore | recap_open | recap_close | add_user
  target      uuid,
  target_name text not null default '',
  detail      jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists admin_audit_created_idx on public.admin_audit (created_at desc);
alter table public.admin_audit enable row level security;
drop policy if exists admin_audit_read on public.admin_audit;
create policy admin_audit_read on public.admin_audit for select to authenticated
  using (public.is_admin());
drop policy if exists admin_audit_insert on public.admin_audit;
create policy admin_audit_insert on public.admin_audit for insert to authenticated
  with check (public.is_admin() and admin_id = auth.uid());

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
  insert into public.admin_audit (admin_id, action, target, target_name)
    values (auth.uid(), 'delete_user', target, coalesce((select name from public.profiles where id = target), ''));
  delete from auth.users where id = target;
end;
$$;

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
  insert into public.admin_audit (admin_id, action, target, target_name)
    values (auth.uid(), 'set_password', target, coalesce((select name from public.profiles where id = target), ''));
  update auth.users
     set encrypted_password = crypt(new_password, gen_salt('bf')),
         updated_at = now()
   where id = target;
  if not found then raise exception 'user not found'; end if;
  delete from auth.refresh_tokens where user_id = target::varchar;
end;
$$;

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

  insert into public.admin_audit (admin_id, action, target_name, detail)
    values (auth.uid(), 'reset_block', p_label, jsonb_build_object('archived_states', v_as, 'archived_board', v_ab,
                                                                 'deleted_states', v_ds, 'deleted_board', v_db));
  return jsonb_build_object('archived_states', v_as, 'archived_board', v_ab,
                            'deleted_states', v_ds, 'deleted_board', v_db,
                            'label', p_label);
end;
$$;

revoke all on function public.admin_reset_block(text) from public;
revoke all on function public.admin_reset_block(text) from anon;
grant execute on function public.admin_reset_block(text) to authenticated;

notify pgrst, 'reload schema';

-- 8) privacy consent stamp (deploy 8)
alter table public.profiles add column if not exists consent_at timestamptz;

-- verify: both counts return (0 rows, no error)
select (select count(*) from public.client_errors) as client_errors, (select count(*) from public.admin_audit) as admin_audit;

-- ============================================================
--  push_days — v1.7.3 close-time sync channel
--  Run once in  Supabase → SQL Editor → New query → Run.
--  (Also appended to schema.sql, which stays the canonical copy.)
-- ============================================================
-- WHY: the browser hard-caps a keepalive request body at 64KB, and the full
-- tracker blob is ~71KB — so the push that fires when the app is closed has
-- been failing for everyone, on every close, silently. A workout logged and
-- followed by an immediate close relied entirely on localStorage recovery at
-- the next open; on an iPhone whose localStorage is silently dead (the 27/07
-- incident) that meant the workout was simply lost.
-- This RPC accepts ONLY the days written this session (~2KB) plus their
-- "last touched" stamps, and merges them into the caller's states blob
-- day-by-day — the same last-writer-wins rule as the client's mergeTrackers,
-- so a stale device can never clobber a newer day through this path.
--
-- SECURITY: invoker rights — RLS (states_owner) still applies, and the
-- function itself only ever touches auth.uid()'s own row.

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

-- PostgREST caches the schema; without this the app keeps getting
-- "Could not find the function public.push_days" for a while.
notify pgrst, 'reload schema';

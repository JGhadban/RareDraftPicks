-- RareDraftPicks schema. Paste into Supabase > SQL Editor and run. Safe to re-run.
--
-- Security model: the anon key in the web page can NOT touch the tables directly.
-- Everything goes through the security-definer functions below, which require the
-- per-person edit token and enforce the deadline.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- tables

create table if not exists public.settings (
  id       int primary key default 1 check (id = 1),
  deadline timestamptz          -- null = no deadline
);
insert into public.settings (id, deadline) values (1, null) on conflict (id) do nothing;

create table if not exists public.submissions (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(name) between 1 and 60),
  edit_token uuid not null unique default gen_random_uuid(),
  picks      jsonb not null default '[]'::jsonb,  -- ordered card names; index 0 = rank 1; duplicates = extra copies
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.settings    enable row level security;
alter table public.submissions enable row level security;
-- No RLS policies on purpose: anon/authenticated get no direct access.
revoke all on public.settings, public.submissions from anon, authenticated;

-- ---------------------------------------------------------------- internal helpers

create or replace function public._assert_open()
returns void language plpgsql security definer set search_path = public as $$
declare d timestamptz;
begin
  select deadline into d from settings where id = 1;
  if d is not null and now() > d then
    raise exception 'Submissions are closed (deadline passed).';
  end if;
end $$;

create or replace function public._assert_valid(p_name text, p_picks jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_name is null or char_length(btrim(p_name)) not between 1 and 60 then
    raise exception 'Name must be 1-60 characters.';
  end if;
  if p_picks is null or jsonb_typeof(p_picks) <> 'array' then
    raise exception 'Picks must be a list.';
  end if;
  if jsonb_array_length(p_picks) > 500 then
    raise exception 'Too many picks (max 500).';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_picks) e
    where jsonb_typeof(e) <> 'string' or char_length(e #>> '{}') not between 1 and 200
  ) then
    raise exception 'Invalid card name in picks.';
  end if;
end $$;

revoke all on function public._assert_open() from public, anon, authenticated;
revoke all on function public._assert_valid(text, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------- public API (RPC)

create or replace function public.get_deadline()
returns timestamptz language sql stable security definer set search_path = public as $$
  select deadline from settings where id = 1;
$$;

create or replace function public.create_submission(p_name text, p_picks jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare t uuid;
begin
  perform _assert_open();
  perform _assert_valid(p_name, p_picks);
  insert into submissions (name, picks) values (btrim(p_name), p_picks)
  returning edit_token into t;
  return t;
end $$;

create or replace function public.get_submission(p_token uuid)
returns json language sql stable security definer set search_path = public as $$
  select json_build_object('name', name, 'picks', picks, 'updated_at', updated_at)
  from submissions where edit_token = p_token;
$$;

create or replace function public.update_submission(p_token uuid, p_name text, p_picks jsonb)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare ts timestamptz;
begin
  perform _assert_open();
  perform _assert_valid(p_name, p_picks);
  update submissions
     set name = btrim(p_name), picks = p_picks, updated_at = now()
   where edit_token = p_token
  returning updated_at into ts;
  if ts is null then
    raise exception 'Edit link not recognised.';
  end if;
  return ts;
end $$;

revoke all on function public.get_deadline()                         from public;
revoke all on function public.create_submission(text, jsonb)         from public;
revoke all on function public.get_submission(uuid)                   from public;
revoke all on function public.update_submission(uuid, text, jsonb)   from public;
grant execute on function public.get_deadline()                       to anon, authenticated;
grant execute on function public.create_submission(text, jsonb)       to anon, authenticated;
grant execute on function public.get_submission(uuid)                 to anon, authenticated;
grant execute on function public.update_submission(uuid, text, jsonb) to anon, authenticated;

-- ---------------------------------------------------------------- results (admin only)

-- One row per (person, rank). Export from Table Editor > picks_flat > Export to CSV.
create or replace view public.picks_flat with (security_invoker = true) as
select s.name,
       e.ord::int          as rank,
       e.card #>> '{}'     as card_name,
       s.updated_at,
       s.id                as submission_id
from public.submissions s
cross join lateral jsonb_array_elements(s.picks) with ordinality as e(card, ord)
order by s.name, s.id, e.ord;

revoke all on public.picks_flat from anon, authenticated;

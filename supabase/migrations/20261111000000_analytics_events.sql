-- Portfolio analytics, phase P0: first-party guest events.
-- NOT applied. Ship as a file; review, then apply to project ywcrzkvwamjchjjkfrve (see supabase/analytics/README.md).
--
-- Rules this file encodes (each has a test in .github/tests/):
--  * Insert only, through the `events` Edge Function calling public.analytics_ingest(). No table grants to anon or authenticated.
--  * There is NO user_id (or email, name, IP) column anywhere. An anon_id is never joined to an account.
--  * props is a flat JSON object with bounded size and count (analytics.json_ok); the function also checks a per-event allow-list.
--  * country comes from the edge header; the IP is never stored.
--  * No time of day is stored: each event has a calendar day only (UTC). Rows for sign_up, sign_in, signup_start and
--    guest_progress_moved (events at or next to account creation or linking) store ONLY the event name, the app, the day, the
--    page area (props.surface) and fresh random ids. The device ID, session ID, platform, app version, source, referrer,
--    country and every other prop (including method and auth_state) are dropped, so they cannot be matched to the same
--    device's other rows. They are counted as events, never per ID; sign-ups are not reported by source or by method.
--    The row id is a random uuid, not a sequence, so insertion order is not kept.
--  * The dashboard read hides small cells: counts of 1 to 4 show as "<5" and small sources fold into "other".
--  * Raw events are kept 14 months (analytics.purge_raw); daily aggregates are kept.

create schema if not exists analytics;
revoke all on schema analytics from public, anon, authenticated;

-- Size and number bounds for props: a flat object, at most 8 keys, scalar values, strings at most 40 chars, 512 chars in all.
create or replace function analytics.json_ok(j jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select j is not null
     and jsonb_typeof(j) = 'object'
     and length(j::text) <= 512
     and (select count(*) from jsonb_object_keys(j)) <= 8
     and not exists (
       select 1 from jsonb_each(j) e
       where jsonb_typeof(e.value) not in ('string', 'number', 'boolean')
          or (jsonb_typeof(e.value) = 'string' and length(e.value #>> '{}') > 40)
     );
$$;
revoke all on function analytics.json_ok(jsonb) from public, anon, authenticated;

create table if not exists analytics.events (
  id              uuid primary key default gen_random_uuid(),
  day             date not null default ((now() at time zone 'UTC')::date),
  app             text not null check (app in ('hub', 'ruffspeak', 'chess', 'ridgeline', 'bbsite')),
  event           text not null check (event ~ '^[a-z][a-z0-9_]{1,39}$'),
  anon_id         uuid not null,
  session_id      uuid not null,
  platform        text check (platform is null or platform in ('web', 'ios', 'android')),
  app_version     text check (app_version is null or app_version ~ '^[0-9A-Za-z._-]{1,20}$'),
  country         text check (country is null or country ~ '^[A-Z]{2}$'),
  utm_source      text check (utm_source is null or utm_source ~ '^[a-z0-9_-]{1,40}$'),
  utm_medium      text check (utm_medium is null or utm_medium ~ '^[a-z0-9_-]{1,40}$'),
  utm_campaign    text check (utm_campaign is null or utm_campaign ~ '^[a-z0-9_-]{1,40}$'),
  referrer_domain text check (referrer_domain is null or referrer_domain ~ '^[a-z0-9.-]{1,80}$'),
  props           jsonb not null default '{}'::jsonb check (analytics.json_ok(props))
);
comment on table analytics.events is
  'First-party guest and usage events. No user_id, email, name or IP by design: the anon_id is a random per-device UUID and is never joined to an account.';

create index if not exists events_day_idx on analytics.events (day);
create index if not exists events_app_day_idx on analytics.events (app, day, event);

-- Aggregates (counts only). The dashboard reads only these.
create table if not exists analytics.daily_app_stats (
  day               date not null,
  app               text not null,
  dau               int not null default 0,
  wau               int not null default 0,
  mau               int not null default 0,
  guest_dau         int not null default 0,
  guest_wau         int not null default 0,
  guest_mau         int not null default 0,
  signups_1d        int not null default 0,
  signups_7d        int not null default 0,
  signups_30d       int not null default 0,
  signins_1d        int not null default 0,
  funnel_app_open   int not null default 0,
  funnel_guest      int not null default 0,
  funnel_popup      int not null default 0,
  funnel_signup_start int not null default 0,
  funnel_sign_up    int not null default 0,
  top_events        jsonb not null default '[]'::jsonb,
  primary key (day, app)
);

create table if not exists analytics.daily_source_stats (
  day     date not null,
  app     text not null,
  source  text not null,
  visits  int not null default 0,
  primary key (day, app, source)
);

create table if not exists analytics.aggregate_runs (
  day     date primary key,
  ran_at  timestamptz not null default now(),
  app_rows int not null default 0
);

alter table analytics.events enable row level security;
alter table analytics.daily_app_stats enable row level security;
alter table analytics.daily_source_stats enable row level security;
alter table analytics.aggregate_runs enable row level security;
revoke all on all tables in schema analytics from public, anon, authenticated;

-- The one way in. SECURITY DEFINER so the function can insert without any table grant; callable only by the service role
-- (the Edge Function). sign_up, sign_in, signup_start and guest_progress_moved rows keep only event, app, day, page area and
-- fresh random ids (stripped here as well as in the function).
-- Takes an array of at most 40 rows already checked by the function; the table checks run again here.
create or replace function public.analytics_ingest(p_rows jsonb) returns int
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 40 then
    raise exception 'analytics_ingest: expected an array of at most 40 rows';
  end if;
  insert into analytics.events (app, event, anon_id, session_id, platform, app_version, country,
                                utm_source, utm_medium, utm_campaign, referrer_domain, props)
  select r.app, r.event,
         case when r.event in ('sign_up', 'sign_in', 'signup_start', 'guest_progress_moved') then gen_random_uuid() else r.anon_id end,
         case when r.event in ('sign_up', 'sign_in', 'signup_start', 'guest_progress_moved') then gen_random_uuid() else r.session_id end,
         case when r.event in ('sign_up', 'sign_in', 'signup_start', 'guest_progress_moved') then null else r.platform end,
         case when r.event in ('sign_up', 'sign_in', 'signup_start', 'guest_progress_moved') then null else r.app_version end,
         case when r.event in ('sign_up', 'sign_in', 'signup_start', 'guest_progress_moved') then null else r.country end,
         case when r.event in ('sign_up', 'sign_in', 'signup_start', 'guest_progress_moved') then null else r.utm_source end,
         case when r.event in ('sign_up', 'sign_in', 'signup_start', 'guest_progress_moved') then null else r.utm_medium end,
         case when r.event in ('sign_up', 'sign_in', 'signup_start', 'guest_progress_moved') then null else r.utm_campaign end,
         case when r.event in ('sign_up', 'sign_in', 'signup_start', 'guest_progress_moved') then null else r.referrer_domain end,
         case when r.event in ('sign_up', 'sign_in', 'signup_start', 'guest_progress_moved') then (case when jsonb_typeof(r.props -> 'surface') = 'string' then jsonb_build_object('surface', r.props -> 'surface') else '{}'::jsonb end)
              else coalesce(r.props, '{}'::jsonb) end
  from jsonb_to_recordset(p_rows) as r(app text, event text, anon_id uuid, session_id uuid, platform text, app_version text,
                                       country text, utm_source text, utm_medium text, utm_campaign text,
                                       referrer_domain text, props jsonb);
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function public.analytics_ingest(jsonb) from public, anon, authenticated;
grant execute on function public.analytics_ingest(jsonb) to service_role;

-- Nightly job, written as a file and NOT scheduled. Idempotent: running a day twice gives the same rows.
-- Usage (by an operator or a scheduler the owner approves): select analytics.aggregate_day(current_date - 1);
-- Users are counted per device ID from every event except sign_up, sign_in, signup_start and guest_progress_moved (those rows
-- carry random ids), so those are counted as events: nothing at account creation is matched to a device.
create or replace function analytics.aggregate_day(p_day date) returns void
language plpgsql set search_path = '' as $$
begin
  delete from analytics.daily_app_stats where day = p_day;
  delete from analytics.daily_source_stats where day = p_day;

  insert into analytics.daily_app_stats
    (day, app, dau, wau, mau, guest_dau, guest_wau, guest_mau, signups_1d, signups_7d, signups_30d, signins_1d,
     funnel_app_open, funnel_guest, funnel_popup, funnel_signup_start, funnel_sign_up, top_events)
  with win as (
    select * from analytics.events where day > p_day - 30 and day <= p_day
  ), apps as (
    select distinct app from win
  ), per as (
    select app, anon_id,
      bool_or(day = p_day) as in1,
      bool_or(day > p_day - 7) as in7,
      bool_or(day = p_day and props ->> 'auth_state' = 'member') as m1,
      bool_or(day > p_day - 7 and props ->> 'auth_state' = 'member') as m7,
      bool_or(props ->> 'auth_state' = 'member') as m30
    from win where event not in ('sign_up', 'sign_in', 'signup_start', 'guest_progress_moved') group by app, anon_id
  ), users as (
    select app,
      count(*) filter (where in1) as dau, count(*) filter (where in7) as wau, count(*) as mau,
      count(*) filter (where in1 and not m1) as guest_dau,
      count(*) filter (where in7 and not m7) as guest_wau,
      count(*) filter (where not m30) as guest_mau
    from per group by app
  ), ev as (
    select app,
      count(*) filter (where event = 'sign_up' and day = p_day) as s1,
      count(*) filter (where event = 'sign_up' and day > p_day - 7) as s7,
      count(*) filter (where event = 'sign_up') as s30,
      count(*) filter (where event = 'sign_in' and day = p_day) as si1,
      count(distinct anon_id) filter (where event = 'app_open' and day = p_day) as f_open,
      count(distinct anon_id) filter (where event = 'guest_continue' and day = p_day) as f_guest,
      count(distinct anon_id) filter (where event = 'guest_popup_seen' and day = p_day) as f_popup,
      count(*) filter (where event = 'signup_start' and day = p_day) as f_start,
      count(*) filter (where event = 'sign_up' and day = p_day) as f_signup
    from win group by app
  ), top as (
    select app, jsonb_agg(jsonb_build_object('event', event, 'n', cnt) order by cnt desc, event) as top_events
    from (
      select app, event, count(*)::int as cnt, row_number() over (partition by app order by count(*) desc, event) as rn
      from win
      where day = p_day and event not in ('app_open', 'guest_continue', 'guest_popup_seen', 'signup_start', 'sign_up', 'sign_in', 'guest_progress_moved')
      group by app, event
    ) x where rn <= 5 group by app
  )
  select p_day, a.app, coalesce(u.dau, 0), coalesce(u.wau, 0), coalesce(u.mau, 0),
         coalesce(u.guest_dau, 0), coalesce(u.guest_wau, 0), coalesce(u.guest_mau, 0),
         ev.s1, ev.s7, ev.s30, ev.si1, ev.f_open, ev.f_guest, ev.f_popup, ev.f_start, ev.f_signup,
         coalesce(top.top_events, '[]'::jsonb)
  from apps a join ev using (app) left join users u using (app) left join top using (app);

  -- Source = utm_source, else the referrer domain, else 'direct'. Visits are app_open events. Sign-ups by source are not
  -- stored: sign_up rows carry no source, so conversion by source is not available, only totals.
  insert into analytics.daily_source_stats (day, app, source, visits)
  select p_day, app, coalesce(utm_source, referrer_domain, 'direct') as source, count(*)
  from analytics.events where day = p_day and event = 'app_open'
  group by 1, 2, 3;

  insert into analytics.aggregate_runs (day, ran_at, app_rows)
  values (p_day, now(), (select count(*) from analytics.daily_app_stats where day = p_day))
  on conflict (day) do update set ran_at = excluded.ran_at, app_rows = excluded.app_rows;
end $$;
revoke all on function analytics.aggregate_day(date) from public, anon, authenticated;

-- Retention: raw events are kept 14 months; aggregates are kept. Not scheduled (scheduling it is a precondition for enabling).
create or replace function analytics.purge_raw() returns int
language plpgsql set search_path = '' as $$
declare v_n int;
begin
  delete from analytics.events where day < ((now() at time zone 'UTC')::date - interval '14 months')::date;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function analytics.purge_raw() from public, anon, authenticated;

-- Small-cell hiding for the dashboard: a count of 1 to 4 shows as the text "<5" (0 and 5 or more show as numbers).
create or replace function analytics.k5(n int) returns jsonb
language sql immutable set search_path = '' as $$
  select case when n between 1 and 4 then to_jsonb('<5'::text) else to_jsonb(n) end;
$$;

-- What the Board Room dashboard reads: aggregates only (no rows, no IDs). Service role only.
-- Headline active-user counts (dau, wau, mau, guest_*) and the day series are returned as they are. Every other count
-- (sign-ups, sign-ins, funnel steps, top events) shows "<5" for 1 to 4, and sources with fewer than 5 visits in the
-- window are folded into "other" (dropped if "other" is still under 5).
create or replace function public.analytics_dashboard(p_days int default 35) returns jsonb
language sql security definer set search_path = '' stable as $$
  with last as (select max(day) as d from analytics.aggregate_runs)
  select jsonb_build_object(
    'generated_at', now(),
    'last_run', (select max(ran_at) from analytics.aggregate_runs),
    'last_day', (select d from last),
    'apps', coalesce((
      select jsonb_agg(jsonb_build_object(
        'app', s.app, 'day', s.day, 'dau', s.dau, 'wau', s.wau, 'mau', s.mau,
        'guest_dau', s.guest_dau, 'guest_wau', s.guest_wau, 'guest_mau', s.guest_mau,
        'signups_1d', analytics.k5(s.signups_1d), 'signups_7d', analytics.k5(s.signups_7d), 'signups_30d', analytics.k5(s.signups_30d),
        'signins_1d', analytics.k5(s.signins_1d),
        'funnel_app_open', analytics.k5(s.funnel_app_open), 'funnel_guest', analytics.k5(s.funnel_guest),
        'funnel_popup', analytics.k5(s.funnel_popup), 'funnel_signup_start', analytics.k5(s.funnel_signup_start),
        'funnel_sign_up', analytics.k5(s.funnel_sign_up),
        'top_events', coalesce((select jsonb_agg(jsonb_build_object('event', t ->> 'event', 'n', analytics.k5((t ->> 'n')::int)) order by ord)
                                from jsonb_array_elements(s.top_events) with ordinality as x(t, ord)), '[]'::jsonb)
      ) order by s.app)
      from analytics.daily_app_stats s where s.day = (select d from last)), '[]'::jsonb),
    'series', coalesce((select jsonb_agg(jsonb_build_object('day', ds.day, 'app', ds.app, 'dau', ds.dau, 'guest_dau', ds.guest_dau) order by ds.day, ds.app)
                        from analytics.daily_app_stats ds
                        where ds.day > (select d from last) - greatest(least(p_days, 60), 1)), '[]'::jsonb),
    'sources', coalesce((
      select jsonb_agg(jsonb_build_object('app', f.app, 'source', f.source, 'visits', f.visits) order by f.app, f.visits desc, f.source)
      from (
        select q.app, case when q.visits >= 5 then q.source else 'other' end as source, sum(q.visits)::int as visits
        from (select app, source, sum(visits)::int as visits
              from analytics.daily_source_stats where day > (select d from last) - 30 group by app, source) q
        group by 1, 2
      ) f where f.visits >= 5), '[]'::jsonb)
  );
$$;
revoke all on function analytics.k5(int) from public, anon, authenticated;
revoke all on function public.analytics_dashboard(int) from public, anon, authenticated;
grant execute on function public.analytics_dashboard(int) to service_role;

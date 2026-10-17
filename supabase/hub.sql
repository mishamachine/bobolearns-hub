-- BoboLearns hub: shared activity log for any site (Chess today, future sites tomorrow).
-- NOT yet applied. Review, then run in the Supabase SQL editor for project ywcrzkvwamjchjjkfrve.
-- The hub dashboard already reads these existing tables: daily_activity, user_settings, user_progress.

create table if not exists public.site_events (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  site        text not null,                 -- e.g. 'chess', 'lingo'
  event       text not null,                 -- e.g. 'game_finished', 'puzzle_solved'
  value       numeric,                       -- optional number (score, minutes, rating)
  meta        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists site_events_user_site_time
  on public.site_events (user_id, site, created_at desc);

alter table public.site_events enable row level security;

drop policy if exists "site_events: read own" on public.site_events;
create policy "site_events: read own" on public.site_events
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "site_events: insert own" on public.site_events;
create policy "site_events: insert own" on public.site_events
  for insert to authenticated with check (user_id = auth.uid());

-- From any BoboLearns site (using the shared boboAuth client):
--   await boboAuth.client.from('site_events').insert({ site: 'chess', event: 'game_finished', value: 1 });

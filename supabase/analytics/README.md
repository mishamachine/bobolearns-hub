# First-party usage counts (guest events), phase P0

State: code and SQL only. Nothing is applied, deployed or switched on. `assets/js/config.js` has `analytics.enabled: false`, so the site sends nothing and creates no ID.

## What it is
- A random per-device ID (UUID v4, in this browser's local storage) and a guest name derived from it by hash. Never from an IP address. Never an account or login ID.
- Events are sent only to our own Edge Function `events`, which checks each one against an allow-list (`supabase/functions/events/schema.js`) and inserts through `public.analytics_ingest()`.
- No row holds both a guest ID and an account ID. There is no user_id column, no identify call and no account_linked event.
- Country comes from the edge header. The IP is never stored by this code (the host and Supabase keep their own logs, which the privacy page discloses). Rate limiting uses a hash of the IP under a key that changes every UTC day and is held only in memory.
- Raw events are kept 13 months (`analytics.purge_raw()`); daily aggregates are kept.
- No Google, Meta or other third-party tag.

## Files
| File | Purpose |
|---|---|
| `migrations/20261111000000_analytics_events.sql` | schema `analytics`, tables, `analytics.json_ok`, `public.analytics_ingest`, `analytics.aggregate_day`, `analytics.purge_raw`, `public.analytics_dashboard` |
| `functions/events/` | the ingest function (`index.ts`), its pure logic (`core.js`) and the allow-list (`schema.js`) |
| `assets/js/bb-analytics.js` | the browser module (ID, guest name, `track`, off switch, DNT/GPC) |
| `.github/tests/analytics.test.mjs` | tests for all of the above, run by `.github/scripts/check_site.py` |

## To switch on (none of this is done; each step needs the owner's go)
1. Finish the privacy copy: the section `#guest-id` in `privacy/index.html` has a TODO. A test keeps counts off while the TODO is there.
2. Apply the migration to project `ywcrzkvwamjchjjkfrve`.
3. Deploy the function: `supabase functions deploy events --no-verify-jwt` (the browser posts text/plain with no auth header).
4. Optional secret `ANALYTICS_RL_SECRET` (shares the rate-limit key between instances); `EVENTS_DISABLED=1` stops writing without a redeploy.
5. Schedule `select analytics.aggregate_day(current_date - 1);` nightly and `select analytics.purge_raw();` monthly (not scheduled by this PR).
6. Set `analytics.enabled` to `true` in `assets/js/config.js` and bump the `?v=` number.

## Roll back
Set `analytics.enabled` to `false` (the site goes quiet at once), set `EVENTS_DISABLED=1`, or delete the function. To remove the data: `drop schema analytics cascade; drop function public.analytics_ingest(jsonb); drop function public.analytics_dashboard(int);`.

## Adding an event or an app
Change the allow-list in both `schema.js` and `assets/js/bb-analytics.js` (a test fails if they differ), and the app list in the migration's check constraint. Prop names containing words like email, name, text, location, verse, document, camera, speech or chat are refused by test and by the function.

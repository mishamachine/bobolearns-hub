# First-party usage counts (guest events), phase P0

State: code and SQL only. Nothing is applied, deployed or switched on. `assets/js/config.js` has `analytics.enabled: false`, so the site sends nothing and creates no ID. The privacy page already carries the final wording and says "Usage counts are currently off."

## What it is
- A random per-device ID (UUID v4, in this browser's local storage) and a guest name derived from it by hash (adjective-animal-4 digits). Never from an IP address. Never an account or login ID.
- Events are sent only to our own Edge Function `events`, which checks each one against an allow-list (`supabase/functions/events/schema.js`) and inserts through `public.analytics_ingest()`.
- No row holds both a guest ID and an account ID. There is no user_id column, no identify call and no account-linked event.
- No time of day is stored: every raw event has a calendar day (UTC) only. `sign_up` and `sign_in` rows carry a fresh random ID (and a random session ID) instead of the device ID, replaced in the function and again in the database. Sign-ups are therefore counted as events, never per ID. The row id is a random uuid, not a sequence. (Physical row order inside Postgres is not controlled by this code.)
- Country comes from the edge header. The IP is never stored by this code (the host and Supabase keep their own logs, which the privacy page discloses). Rate limiting uses a hash of the IP under a key that changes every UTC day and is held only in memory.
- Raw events are kept 14 months (`analytics.purge_raw()`); daily aggregates (no IDs) are kept.
- No Google, Meta or other third-party tag.

## Files
| File | Purpose |
|---|---|
| `migrations/20261111000000_analytics_events.sql` | schema `analytics`, tables, `analytics.json_ok`, `public.analytics_ingest`, `analytics.aggregate_day`, `analytics.purge_raw`, `public.analytics_dashboard` |
| `functions/events/` | ingest: `index.ts` (wiring), `handler.js` (request handling), `core.js` (validation, limiter), `schema.js` (allow-list) |
| `functions/analytics-dashboard/index.ts` | read side for the Board Room proxy: checks a shared secret in constant time, then calls `public.analytics_dashboard()` with the service role that stays here |
| `assets/js/bb-analytics.js` | the browser module (ID, guest name, `track`, off switch, DNT/GPC) |
| `.github/tests/analytics.test.mjs` | tests for all of the above, run by `.github/scripts/check_site.py` |

## Rate limiting and headers (UNVERIFIED on the real platform)
- The limiter reads only `cf-connecting-ip`. Reason: it is set by the platform's edge (Cloudflare fronts Supabase Edge Functions) and overwritten if a client sends one, so a client cannot choose its own bucket. The leftmost `x-forwarded-for` is client-controlled and is never read. Requests without the header share one `no-ip` bucket.
- The country comes from `cf-ipcountry`. Both header names are unverified until the first deploy; check them with one test request, and if a header is absent the effect is a null country and a shared bucket, not a failure.
- The table of tracked clients is capped at 5000: expired entries are dropped first, then the least recently seen. The cap never clears everyone's count.
- Body limit 8192 bytes, refused from the declared length before reading, and the read itself stops at 8192. 20 events per request.

## Preconditions for enabling (none are done)
1. Scheduling is a precondition: `select analytics.aggregate_day(current_date - 1);` nightly and `select analytics.purge_raw();` monthly, by a scheduler the owner approves. Without `purge_raw` the 14-month sentence on the privacy page would be untrue; without `aggregate_day` the dashboard shows nothing.
2. Apply the migration to the shared Supabase project.
3. Deploy: `supabase functions deploy events --no-verify-jwt` (the browser posts text/plain with no auth header) and `supabase functions deploy analytics-dashboard --no-verify-jwt`.
4. Secrets: `ANALYTICS_DASHBOARD_SECRET` (random, at least 24 characters; the same value goes in the dashboard proxy). Optional: `ANALYTICS_RL_SECRET` (shares the limiter key between instances), `EVENTS_DISABLED=1` (stop writing), `EVENTS_DEV_ORIGINS=1` (accept http://localhost; development only, never production).
5. The enabling PR must make exactly these static edits in `privacy/index.html`, because the page must be true without JavaScript:
   - In section 3, change `We do not use advertising, analytics or cross-site tracking cookies.` to `We do not use advertising or cross-site tracking cookies.`
   - In `#guest-id`, delete the line `Usage counts are currently off.`
   - Set `analytics.enabled` to `true` in `assets/js/config.js` and bump the `?v=` number.
   A test fails if the flag is on and either old line is still there (or if it is off and either is missing).

## Roll back
Set `analytics.enabled` to `false` (the site goes quiet at once, and put the two static lines back), set `EVENTS_DISABLED=1`, or delete the functions. To remove the data: `drop schema analytics cascade; drop function public.analytics_ingest(jsonb); drop function public.analytics_dashboard(int);`.

## Adding an event or an app
Change the allow-list in both `schema.js` and `assets/js/bb-analytics.js` (a test fails if they differ), and the app list in the migration's check constraint. Prop names containing words like email, name, text, location, verse, document, camera, speech or chat are refused by test and by the function.

# No-join rule (D-078)

Adopted by Nizam al-Mulk, 16 Nov 2026, from Babar's ruling of 15 Nov 2026. Tests: `.github/tests/no-join.test.mjs` (T1 to T6), run by `.github/scripts/check_site.py` on every PR.

**Guest usage events are never linked to an account or a person.**

a. Guest event tables hold only: a random guest ID, an event name, a content/screen identifier, a date, and an app name. No user_id, email, IP address, account ID, push token, device fingerprint, or anything derived from them.

b. No foreign key, view, SQL function, RPC, Edge Function, trigger, dashboard query, export or script may join, match or correlate guest event tables with auth.users, profiles or any account table, by any key (guest ID, device ID, time, fingerprint).

c. The app never writes the guest ID into any account-linked table or request. After sign-in or sign-up, the app stops sending events under that guest ID (signed-in usage, if tracked, uses a separate path the privacy page already describes).

d. App users (anon and authenticated roles) cannot read guest event tables. Reads are by the service role into aggregate counts only; dashboards show totals, never single guest IDs.

e. Any PR touching guest tables, the event client or reporting views needs a CTO Reviewer check against this rule and a one-line CBO note. A breach is a High escalation to Nizam and Misha the same day: reverse it or pull the privacy line, whichever is faster.

## Known gap against (a), recorded so the test is honest

The shipped `analytics.events` table also holds a random row id, a random session id, platform, app version, country, utm source/medium/campaign and referrer domain. These are coarse context fields, not account links, but they are more than (a) lists. Test T1 pins them in an explicit "pending CBO sign-off" list: a new column fails the test, and removing one tightens it. Either the CBO accepts them (then edit (a) and that list in the same PR) or they are dropped.

## What the tests check

| Test | Rule | Checks |
|---|---|---|
| T1 | a | exact column list of every analytics table; no forbidden or derived column names; prop names |
| T2 | b | no foreign key from any analytics table to anything |
| T3 | b | no SQL statement, view, function or Edge Function mentions an analytics object together with auth.users, profiles or another account table (the scanner is proven on a bad sample) |
| T4 | d | RLS on, all grants revoked from anon, authenticated and public, no policies; service role only. Run in a real Postgres engine too when `PGLITE_DIR` is set |
| T5 | c | after a simulated sign-in the old guest ID is deleted and never sent; no request carries both a session token and a guest ID |
| T6 | retention | `analytics.purge_raw()` deletes events older than N months; N equals the privacy page; scheduling stays a recorded precondition for turning counts on |

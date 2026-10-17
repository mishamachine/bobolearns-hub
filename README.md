# BoboLearns hub (bobolearns.com)

Live at https://bobolearns.com. Static site (HTML/CSS/JS, no build step) that links every BoboLearns learning site, provides the shared login, and shows cross-site stats. A project by [Babar Ali](https://babarali.com).

| Path | Purpose |
|---|---|
| `/` | Landing page: what it is, sites, FAQ |
| `/login/` | Sign in / sign up (Google, Apple, email + password), password reset |
| `/dashboard/` | Logged-in stats: today, streak, 7-day chart, per-site stats |
| `/privacy/`, `/terms/` | Legal pages (drafts: have counsel review) |
| `sites.json` | **Registry of all sites. Add one entry to add a site.** |
| `assets/js/bobo-auth.js` | Shared auth client (cookie session on `.bobolearns.com`) |
| `supabase/hub.sql` | Optional `site_events` table (not applied yet) |

## Deploy (Hostinger + GitHub)
1. hPanel → **Websites → bobolearns.com → Git** → create a repository: `https://github.com/mishamachine/bobolearns-hub`, branch `main`, directory `public_html`.
2. Copy the **webhook URL** Hostinger shows into GitHub → repo **Settings → Webhooks** (content type `application/json`, push events). Every push to `main` then auto-deploys.
3. Don't delete the subdomain folders (`lingo`, `chess`) that live inside `public_html`.

## Supabase setup (project `ywcrzkvwamjchjjkfrve`)
1. **Authentication → URL Configuration:** Site URL `https://bobolearns.com`; add redirect URLs `https://bobolearns.com/**`, `https://lingo.bobolearns.com/**`, `https://chess.bobolearns.com/**`.
2. **Providers → Google:** already configured for Lingo; no change needed for the hub.
3. **Providers → Apple:** needs a paid Apple Developer account (Services ID, key, team ID). The button is live but returns an error until configured.
4. Optional: run `supabase/hub.sql` so Chess (and future sites) can log activity.

## Single sign-on across sites
Lingo and Chess already store their Supabase session in a cookie on `.bobolearns.com` (`src/lib/cookieStorage.ts`). The hub's `assets/js/bobo-auth.js` uses the identical cookie format and the default Supabase storage key, so one login works on all three. **Keep these in sync:** if you change the cookie logic in one place, change it everywhere.

To send a signed-out user from another site to the hub's login: `https://bobolearns.com/login/?next=<their site URL>`. Only `*.bobolearns.com` destinations are honored.

## Add a new site
Add an object to `sites.json` (`slug`, `name`, `url`, `status`, `tagline`, `stats`, `lastActive`) and push. Stats are declarative (`count`, `sum`, `avg`, `distinct` over a Supabase table filtered to the user).

## Before launch checklist
- Confirm hello@babarali.com is a working mailbox (set in `assets/js/config.js`, with matching fallbacks in the HTML).
- Apple sign-in is hidden. Set `providers.apple` to `true` in `assets/js/config.js` after configuring it in Supabase.
- Have the Privacy Policy and Terms reviewed.

## Cache busting
Assets are cached for up to an hour (see `.htaccess`). Their links carry `?v=N` (currently 3). When you change any CSS or JS, bump `N` in the HTML files so visitors get the new version right away.

// Read side for the Board Room dashboard. The proxy calls this with GET and the header x-dashboard-secret; the function
// compares it in constant time with ANALYTICS_DASHBOARD_SECRET and then calls public.analytics_dashboard() (aggregates
// only, no rows, no IDs) with the service role that lives here. The proxy never holds a database key.
//
// Deploy WITHOUT JWT verification: supabase functions deploy analytics-dashboard --no-verify-jwt   (an operator step; not done here)
// Secrets: ANALYTICS_DASHBOARD_SECRET (random, at least 24 characters; the same value goes in the proxy), plus the
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY that Supabase provides.
import { createDashboardHandler } from '../events/handler.js';

Deno.serve(createDashboardHandler({ env: (k: string) => Deno.env.get(k) }));

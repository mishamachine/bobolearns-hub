-- Rollback for 20261111000000_analytics_events.sql. NOT applied by anyone but the owner; deletes all analytics data.
drop function if exists public.analytics_ingest(jsonb);
drop function if exists public.analytics_dashboard(int);
drop schema if exists analytics cascade; -- its tables, functions and the data in them

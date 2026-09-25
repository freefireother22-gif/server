-- Fix Admin Panel plan changes on legacy users tables.
-- Some older schemas marked trial_started_at as NOT NULL, but switching to
-- PRO/PREMIUM/FREE correctly clears the trial fields. Run once in Supabase.
alter table public.users add column if not exists trial_started_at timestamptz;
alter table public.users add column if not exists trial_ends_at timestamptz;
alter table public.users add column if not exists subscription_started_at timestamptz;
alter table public.users add column if not exists subscription_ends_at timestamptz;

alter table public.users alter column trial_started_at drop not null;
alter table public.users alter column trial_ends_at drop not null;
alter table public.users alter column subscription_started_at drop not null;
alter table public.users alter column subscription_ends_at drop not null;

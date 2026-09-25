-- Fix Admin Panel plan changes on older databases.
-- Run once in Supabase SQL Editor before redeploying the backend.
-- Safe to run multiple times; existing data is preserved.

alter table public.users add column if not exists plan text not null default 'TRIAL';
alter table public.users add column if not exists account_status text not null default 'ACTIVE';
alter table public.users add column if not exists trial_started_at timestamptz;
alter table public.users add column if not exists trial_ends_at timestamptz;
alter table public.users add column if not exists subscription_started_at timestamptz;
alter table public.users add column if not exists subscription_ends_at timestamptz;

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  firebase_uid text not null,
  plan text not null,
  source text not null default 'UNKNOWN',
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  active boolean not null default true,
  note text,
  created_at timestamptz not null default now()
);

alter table public.subscriptions add column if not exists firebase_uid text;
alter table public.subscriptions add column if not exists plan text;
alter table public.subscriptions add column if not exists source text default 'UNKNOWN';
alter table public.subscriptions add column if not exists starts_at timestamptz default now();
alter table public.subscriptions add column if not exists ends_at timestamptz;
alter table public.subscriptions add column if not exists active boolean default true;
alter table public.subscriptions add column if not exists note text;
alter table public.subscriptions add column if not exists created_at timestamptz default now();

create index if not exists subscriptions_firebase_uid_active_idx
  on public.subscriptions(firebase_uid, active, ends_at);

-- Repair null legacy values so the API can update plans without constraint errors.
update public.users set plan = 'TRIAL' where plan is null or trim(plan) = '';
update public.users set account_status = 'ACTIVE' where account_status is null or trim(account_status) = '';
update public.subscriptions set source = 'UNKNOWN' where source is null or trim(source) = '';
update public.subscriptions set active = true where active is null;

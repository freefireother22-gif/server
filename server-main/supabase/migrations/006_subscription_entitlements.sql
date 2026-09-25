-- DoraGuard subscription, redeem-code and plan-limit storage.
-- Run after the existing users/subscriptions/admin tables.

create table if not exists public.plan_config (
  plan text primary key check (plan in ('TRIAL','FREE','PRO','PREMIUM')),
  duration_days integer not null default 0 check (duration_days >= 0),
  max_child_devices integer not null default 0 check (max_child_devices >= 0),
  features jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by text
);

insert into public.plan_config(plan, duration_days, max_child_devices, features)
values
  ('TRIAL', 3, 1, '{"SCREEN_SHARING":true,"SCREEN_MIRRORING":true,"REMOTE_CAMERA":true,"ONE_WAY_AUDIO":true,"APP_LOCKING":true,"CALL_LOGS":true,"MESSAGE_LOGS":true,"APP_USAGE":true,"LIVE_LOCATION":true,"MAP_LOCATION":true,"PARENTAL_CONTROL":true}'),
  ('FREE', 0, 0, '{"SCREEN_SHARING":false,"SCREEN_MIRRORING":false,"REMOTE_CAMERA":false,"ONE_WAY_AUDIO":false,"APP_LOCKING":false,"CALL_LOGS":false,"MESSAGE_LOGS":false,"APP_USAGE":false,"LIVE_LOCATION":false,"MAP_LOCATION":false,"PARENTAL_CONTROL":false}'),
  ('PRO', 30, 3, '{"SCREEN_SHARING":true,"SCREEN_MIRRORING":true,"REMOTE_CAMERA":true,"ONE_WAY_AUDIO":true,"APP_LOCKING":true,"CALL_LOGS":true,"MESSAGE_LOGS":true,"APP_USAGE":true,"LIVE_LOCATION":true,"MAP_LOCATION":true,"PARENTAL_CONTROL":true}'),
  ('PREMIUM', 365, 10, '{"SCREEN_SHARING":true,"SCREEN_MIRRORING":true,"REMOTE_CAMERA":true,"ONE_WAY_AUDIO":true,"APP_LOCKING":true,"CALL_LOGS":true,"MESSAGE_LOGS":true,"APP_USAGE":true,"LIVE_LOCATION":true,"MAP_LOCATION":true,"PARENTAL_CONTROL":true}')
on conflict (plan) do nothing;

create table if not exists public.redeem_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  plan text not null check (plan in ('TRIAL','FREE','PRO','PREMIUM')),
  duration_days integer not null default 0 check (duration_days >= 0),
  max_uses integer not null default 1 check (max_uses > 0),
  used_count integer not null default 0 check (used_count >= 0),
  expires_at timestamptz,
  active boolean not null default true,
  note text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Some older installations already have redeem_codes with UUID ids and/or an
-- extra_days column. Keep that data compatible with the new API.
alter table public.redeem_codes
  add column if not exists code text;
alter table public.redeem_codes
  add column if not exists plan text not null default 'PRO';
alter table public.redeem_codes
  add column if not exists duration_days integer not null default 0;
alter table public.redeem_codes
  add column if not exists max_uses integer not null default 1;
alter table public.redeem_codes
  add column if not exists used_count integer not null default 0;
alter table public.redeem_codes
  add column if not exists expires_at timestamptz;
alter table public.redeem_codes
  add column if not exists active boolean not null default true;
alter table public.redeem_codes
  add column if not exists note text;
alter table public.redeem_codes
  add column if not exists created_by text;
alter table public.redeem_codes
  add column if not exists created_at timestamptz not null default now();
alter table public.redeem_codes
  add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'redeem_codes'
      and column_name = 'extra_days'
  ) then
    execute 'update public.redeem_codes
             set duration_days = coalesce(duration_days, extra_days, 0)
             where duration_days = 0';
  end if;
end $$;

create table if not exists public.redeem_code_redemptions (
  id uuid primary key default gen_random_uuid(),
  code_id uuid not null references public.redeem_codes(id) on delete cascade,
  firebase_uid text not null,
  plan text not null,
  ends_at timestamptz,
  redeemed_at timestamptz not null default now(),
  unique(code_id, firebase_uid)
);

create index if not exists redeem_codes_active_idx
  on public.redeem_codes(active, expires_at);
create index if not exists redeem_redemptions_user_idx
  on public.redeem_code_redemptions(firebase_uid, redeemed_at desc);

-- The child Firebase UID can change after reinstall.  Keep the verified
-- parent owner separately so plan device limits remain correct.
alter table public.device_registry
  add column if not exists owner_firebase_uid text;
create index if not exists device_registry_owner_role_idx
  on public.device_registry(owner_firebase_uid, role);

alter table public.plan_config enable row level security;
alter table public.redeem_codes enable row level security;
alter table public.redeem_code_redemptions enable row level security;
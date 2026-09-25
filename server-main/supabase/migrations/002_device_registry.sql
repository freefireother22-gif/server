-- ParentGuard device registry used by the Admin Panel.
-- Run after the original monitoring migration. The Render service role is the only writer.
create table if not exists public.device_registry (
  device_id text primary key,
  firebase_uid text not null,
  role text not null default 'unknown' check (role in ('parent', 'child', 'unknown')),
  pairing_id text,
  device_name text,
  app_version text,
  platform text not null default 'android',
  battery_percent integer check (battery_percent between 0 and 100),
  is_charging boolean,
  is_online boolean not null default true,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists device_registry_pairing_idx on public.device_registry(pairing_id);
create index if not exists device_registry_seen_idx on public.device_registry(last_seen_at desc);
alter table public.device_registry enable row level security;

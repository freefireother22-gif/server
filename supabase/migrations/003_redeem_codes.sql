create extension if not exists pgcrypto;

create table if not exists public.redeem_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  plan text not null default 'PRO'
    check (plan in ('TRIAL', 'FREE', 'PRO', 'PREMIUM')),
  extra_days integer not null default 0
    check (extra_days >= 0 and extra_days <= 3650),
  max_uses integer not null default 1 check (max_uses >= 1),
  used_count integer not null default 0 check (used_count >= 0),
  expires_at timestamptz,
  note text,
  created_by text,
  created_at timestamptz not null default now(),
  active boolean not null default true
);

create index if not exists redeem_codes_code_idx on public.redeem_codes(code);
alter table public.redeem_codes enable row level security;
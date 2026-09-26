-- Secure, short-lived Parent-to-Child pairing codes handled only by Render.
create table if not exists public.pairing_otps (
  code_hash text primary key,
  parent_firebase_uid text not null,
  parent_account_id text not null,
  parent_device_id text not null,
  parent_email text,
  expires_at timestamptz not null,
  used_at timestamptz,
  child_firebase_uid text,
  child_device_id text,
  child_device_name text,
  child_model text,
  pairing_id text unique,
  created_at timestamptz not null default now()
);

create index if not exists pairing_otps_parent_device_idx
  on public.pairing_otps(parent_device_id, created_at desc);
create index if not exists pairing_otps_expiry_idx
  on public.pairing_otps(expires_at);

alter table public.pairing_otps enable row level security;
-- No client policy is intentional: only the Render service-role backend accesses this table.

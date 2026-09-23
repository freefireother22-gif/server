-- Restore the three original hardcoded Parent banners as editable database rows.
-- Run this once if the Upgrade Banners table currently shows only newly-created banners.
-- It is safe to run once after 004_promo_banners.sql.

insert into public.promo_banners (title, body, button_text, target_plan, display_order)
select 'Upgrade to Pro', 'Unlock full monitoring, live screen, and more', 'Upgrade', 'ALL', 0
where not exists (
  select 1 from public.promo_banners
  where deleted_at is null
    and title = 'Upgrade to Pro'
    and body = 'Unlock full monitoring, live screen, and more'
    and display_order = 0
);

insert into public.promo_banners (title, body, button_text, target_plan, display_order)
select 'Upgrade to Pro', 'Unlock full monitoring, live screen, and more', 'Upgrade', 'ALL', 1
where not exists (
  select 1 from public.promo_banners
  where deleted_at is null
    and title = 'Upgrade to Pro'
    and body = 'Unlock full monitoring, live screen, and more'
    and display_order = 1
);

insert into public.promo_banners (title, body, button_text, target_plan, display_order)
select 'Upgrade to Pro', 'Unlock full monitoring, live screen, and more', 'Upgrade', 'ALL', 2
where not exists (
  select 1 from public.promo_banners
  where deleted_at is null
    and title = 'Upgrade to Pro'
    and body = 'Unlock full monitoring, live screen, and more'
    and display_order = 2
);

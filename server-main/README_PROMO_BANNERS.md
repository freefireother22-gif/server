# ParentGuard: Admin-managed Upgrade Banners

This feature adds editable rotating upgrade banners to the Parent app.

## What changed
- Admin Panel: new **Upgrade Banners** section.
- Admin can create, edit, reorder, activate/deactivate, and delete banners.
- Parent app loads active banners for the signed-in user's plan.
- If the API is unavailable, the Parent app keeps the original three local banners.
- Rotation remains 5 seconds and the existing UI/style is preserved.
- Existing monitoring, WebRTC, Firebase auth, pairing, and database routes are not changed.

## Setup order
1. In Supabase SQL Editor, run `server-main/supabase/migrations/004_promo_banners.sql` once.
2. Deploy the updated `server-main` folder to the same Render backend.
3. Deploy the updated `admin-panel` folder to the admin hosting service.
4. Build/install the updated Parent Android project.
5. Open Admin Panel > Upgrade Banners and edit the three seeded banners.

## Important
- Keep Render environment variables unchanged.
- Never upload Supabase service-role keys or Firebase private keys to GitHub.
- The Parent app uses the existing Render URL from `SIGNALING_WSS_URL`.

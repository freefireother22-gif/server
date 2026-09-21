# ParentGuard Backend v2 Setup

This version preserves the existing WebRTC signaling protocol and adds secure Firebase/Supabase APIs.

## Included
- Existing Parent/Child WebSocket routing remains compatible.
- Firebase ID-token verification.
- First verified Google login creates a 3-day trial once.
- Expired trial or paid plan automatically becomes FREE when checked.
- Admin user list and dashboard counts.
- Admin plan changes: TRIAL, FREE, PRO, PREMIUM.
- Admin account controls: ACTIVE, SUSPENDED, BANNED.
- Subscription history and audit logs.

## Render environment variables
Already added:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Still required before authenticated APIs work:
- `FIREBASE_PROJECT_ID`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY`

Optional:
- `ADMIN_ALLOWED_ORIGINS=http://localhost:3000,http://localhost:5173`

Never commit real secret values to GitHub.

## Deploy
1. Replace the repository files with this package.
2. Commit and push to the same GitHub branch used by Render.
3. Render runs `npm install` and `npm start` automatically.
4. Open `https://YOUR-RENDER-SERVICE/health`.
5. Confirm:
   - `status` = `ok`
   - `platform.supabaseConfigured` = `true`
   - `platform.databaseReachable` = `true`
   - `platform.firebaseAdminConfigured` = `true` after adding Firebase Admin values.

## Approve the first Admin
After choosing the Gmail address for the Admin Panel, run in Supabase SQL Editor:

```sql
insert into public.admin_users (email, role, active)
values ('YOUR_ADMIN_GMAIL@gmail.com', 'OWNER', true)
on conflict (email) do update
set role = 'OWNER', active = true;
```

The first successful Admin API login securely links that email row to its Firebase UID.

## API routes
All routes below require `Authorization: Bearer FIREBASE_ID_TOKEN`.

User:
- `POST /api/v1/auth/session`
- `GET /api/v1/me`

Admin:
- `GET /api/v1/admin/dashboard`
- `GET /api/v1/admin/users?limit=50`
- `PATCH /api/v1/admin/users/:firebaseUid/plan`
- `PATCH /api/v1/admin/users/:firebaseUid/status`

Plan body example:
```json
{
  "plan": "PRO",
  "endsAt": "2026-12-31T23:59:59Z",
  "reason": "Manual payment received"
}
```

Ban body example:
```json
{
  "status": "BANNED",
  "reason": "Terms violation"
}
```

## Important compatibility note
WebSocket REGISTER remains backward compatible and is not Firebase-token protected yet. Enforce tokens there only after both Android apps are updated to send Firebase tokens; otherwise existing screen/audio signaling would break.

'use strict';
const { getSupabase, verifyFirebaseBearer } = require('./platform');
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
  return true;
}
async function handleDeviceApi(req, res, url) {
  if (req.method !== 'POST' || url.pathname !== '/api/v1/devices/fcm-token') return false;
  try {
    const decoded = await verifyFirebaseBearer(req.headers.authorization);
    let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 100000) return json(res, 413, { ok: false, error: 'Request too large' }); }
    const body = raw ? JSON.parse(raw) : {};
    if (!body.token) return json(res, 400, { ok: false, error: 'token is required' });
    const db = getSupabase();
    const row = { device_id: String(body.deviceId || ''), firebase_uid: decoded.uid, token: String(body.token), platform: 'android', app_version: body.appVersion ? String(body.appVersion) : null, active: true, last_seen_at: new Date().toISOString() };
    const { data, error } = await db.from('device_fcm_tokens').upsert(row, { onConflict: 'token' }).select('*').single();
    if (error) throw new Error(error.message);
    return json(res, 200, { ok: true, token: data });
  } catch (_) { return json(res, 401, { ok: false, error: 'FCM token registration failed' }); }
}
module.exports = { handleDeviceApi };

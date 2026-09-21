'use strict';

const { getSupabase, getFirebaseAdmin, verifyFirebaseBearer } = require('./platform');

async function requireApprovedAdmin(req) {
  const decoded = await verifyFirebaseBearer(req.headers.authorization);
  if (!decoded.email || decoded.email_verified !== true || decoded.firebase?.sign_in_provider !== 'google.com') {
    const error = new Error('Verified Google Admin account required'); error.statusCode = 403; throw error;
  }
  const db = getSupabase();
  let { data: adminUser, error } = await db.from('admin_users').select('*').eq('firebase_uid', decoded.uid).eq('active', true).maybeSingle();
  if (error) throw new Error(`Unable to verify administrator: ${error.message}`);
  if (!adminUser) {
    ({ data: adminUser, error } = await db.from('admin_users').select('*').eq('email', decoded.email.toLowerCase()).eq('active', true).maybeSingle());
    if (error) throw new Error(`Unable to verify administrator: ${error.message}`);
    if (adminUser && !adminUser.firebase_uid) {
      const linked = await db.from('admin_users').update({ firebase_uid: decoded.uid }).eq('id', adminUser.id).select('*').single();
      if (!linked.error) adminUser = linked.data;
    }
  }
  if (!adminUser) { const e = new Error('Administrator access is not approved'); e.statusCode = 403; throw e; }
  return { decoded, adminUser };
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''; req.on('data', chunk => { raw += chunk; if (raw.length > 1024 * 1024) { const e = new Error('Body too large'); e.statusCode = 413; reject(e); req.destroy(); } });
    req.on('end', () => { if (!raw) return resolve({}); try { resolve(JSON.parse(raw)); } catch (_) { const e = new Error('Invalid JSON'); e.statusCode = 400; reject(e); } }); req.on('error', reject);
  });
}
function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }

async function sendCampaign(campaign, targetPlan) {
  const db = getSupabase();
  let q = db.from('device_fcm_tokens').select('id,device_id,firebase_uid,token').eq('active', true);
  if (targetPlan && targetPlan !== 'ALL') {
    const users = await db.from('users').select('firebase_uid').eq('plan', targetPlan).eq('account_status', 'ACTIVE');
    if (users.error) throw new Error(users.error.message);
    const ids = (users.data || []).map(x => x.firebase_uid);
    if (!ids.length) return { sent: 0, failed: 0 };
    q = q.in('firebase_uid', ids);
  }
  const tokens = (await q).data || [];
  const messaging = getFirebaseAdmin().messaging();
  let sent = 0; let failed = 0;
  for (let i = 0; i < tokens.length; i += 500) {
    const chunk = tokens.slice(i, i + 500);
    const result = await messaging.sendEachForMulticast({
      tokens: chunk.map(x => x.token),
      notification: { title: campaign.title, body: campaign.body },
      data: { type: 'ADMIN_CAMPAIGN', campaignId: String(campaign.id), title: campaign.title || '', body: campaign.body || '', actionUrl: campaign.action_url || '' },
      android: { priority: 'high', notification: { channelId: 'parentguard_admin' } }
    });
    sent += result.successCount; failed += result.failureCount;
    const rows = chunk.map((x, index) => ({ campaign_id: campaign.id, device_id: x.device_id, firebase_uid: x.firebase_uid, token: x.token, status: result.responses[index]?.success ? 'sent' : 'failed', sent_at: new Date().toISOString(), error_message: result.responses[index]?.error?.message || null }));
    await db.from('notification_campaign_deliveries').insert(rows);
  }
  return { sent, failed };
}

async function handleControlPanelApi(req, res, url) {
  const path = url.pathname;
  const supported = path === '/api/v1/admin/devices' || path === '/api/v1/admin/pairings' || path === '/api/v1/admin/releases' || path === '/api/v1/admin/campaigns' || path === '/api/v1/admin/settings/maintenance' || /^\/api\/v1\/admin\/campaigns\/[^/]+$/.test(path);
  if (!supported || !['GET', 'POST', 'DELETE'].includes(req.method)) return false;
  try {
    const { decoded, adminUser } = await requireApprovedAdmin(req);
    const db = getSupabase();
    if (req.method === 'GET' && path === '/api/v1/admin/devices') {
      const { data, error } = await db.from('devices').select('*').order('last_seen_at', { ascending: false }).limit(500);
      if (error) throw new Error(error.message); return json(res, 200, { ok: true, devices: data || [] });
    }
    if (req.method === 'GET' && path === '/api/v1/admin/pairings') {
      const { data, error } = await db.from('pairings').select('*').order('created_at', { ascending: false }).limit(500);
      if (error) throw new Error(error.message); return json(res, 200, { ok: true, pairings: data || [] });
    }
    if (req.method === 'GET' && path === '/api/v1/admin/settings/maintenance') {
      const { data, error } = await db.from('app_control_settings').select('*').eq('id', true).maybeSingle();
      if (error) throw new Error(error.message); return json(res, 200, { ok: true, settings: data || { maintenance_mode: false } });
    }
    if (req.method === 'POST' && path === '/api/v1/admin/settings/maintenance') {
      const body = await parseBody(req);
      const row = { id: true, maintenance_mode: Boolean(body.enabled), maintenance_title: String(body.title || 'ParentGuard is under maintenance'), maintenance_message: String(body.message || 'Please try again later.'), maintenance_until: body.until || null, updated_by: decoded.uid, updated_at: new Date().toISOString() };
      const { data, error } = await db.from('app_control_settings').upsert(row, { onConflict: 'id' }).select('*').single();
      if (error) throw new Error(error.message);
      await db.from('audit_logs').insert({ admin_firebase_uid: adminUser.firebase_uid || decoded.uid, action: body.enabled ? 'MAINTENANCE_ENABLED' : 'MAINTENANCE_DISABLED', target_type: 'APP_CONTROL', target_id: 'global', new_value: data, reason: row.maintenance_message });
      return json(res, 200, { ok: true, settings: data });
    }
    if (req.method === 'GET' && path === '/api/v1/admin/releases') {
      const { data, error } = await db.from('app_releases').select('*').order('published_at', { ascending: false }).limit(100);
      if (error) throw new Error(error.message); return json(res, 200, { ok: true, releases: data || [] });
    }
    if (req.method === 'POST' && path === '/api/v1/admin/releases') {
      const body = await parseBody(req); const versionCode = Number(body.versionCode);
      if (!body.versionName || !Number.isInteger(versionCode) || !body.downloadUrl) { const e = new Error('versionName, versionCode and downloadUrl are required'); e.statusCode = 400; throw e; }
      const row = { version_name: String(body.versionName), version_code: versionCode, download_url: String(body.downloadUrl), release_notes: String(body.releaseNotes || ''), minimum_supported_version_code: body.mandatory ? versionCode : Number(body.minimumSupportedVersionCode || 0) || null, mandatory: Boolean(body.mandatory), is_active: true, published_by: decoded.uid, published_at: new Date().toISOString() };
      const { data, error } = await db.from('app_releases').insert(row).select('*').single(); if (error) throw new Error(error.message);
      await db.from('audit_logs').insert({ admin_firebase_uid: adminUser.firebase_uid || decoded.uid, action: 'APP_RELEASE_PUBLISHED', target_type: 'APP_RELEASE', target_id: String(data.id), new_value: data, reason: body.releaseNotes || null });
      return json(res, 201, { ok: true, release: data });
    }
    if (req.method === 'GET' && path === '/api/v1/admin/campaigns') {
      const { data, error } = await db.from('notification_campaigns').select('*').is('deleted_at', null).order('created_at', { ascending: false }).limit(100);
      if (error) throw new Error(error.message); return json(res, 200, { ok: true, campaigns: data || [] });
    }
    if (req.method === 'POST' && path === '/api/v1/admin/campaigns') {
      const body = await parseBody(req); if (!body.title || !body.body) { const e = new Error('title and body are required'); e.statusCode = 400; throw e; }
      const row = { title: String(body.title), body: String(body.body), action_url: body.actionUrl ? String(body.actionUrl) : null, target_plan: String(body.targetPlan || 'ALL'), status: 'sending', created_by: decoded.uid, created_at: new Date().toISOString() };
      const created = await db.from('notification_campaigns').insert(row).select('*').single(); if (created.error) throw new Error(created.error.message);
      const result = await sendCampaign(created.data, row.target_plan);
      await db.from('notification_campaigns').update({ status: 'sent' }).eq('id', created.data.id);
      await db.from('audit_logs').insert({ admin_firebase_uid: adminUser.firebase_uid || decoded.uid, action: 'NOTIFICATION_CAMPAIGN_SENT', target_type: 'CAMPAIGN', target_id: String(created.data.id), new_value: { ...created.data, result }, reason: row.title });
      return json(res, 201, { ok: true, campaign: { ...created.data, status: 'sent' }, delivery: result });
    }
    const deleteMatch = /^\/api\/v1\/admin\/campaigns\/([^/]+)$/.exec(path);
    if (req.method === 'DELETE' && deleteMatch) {
      const { error } = await db.from('notification_campaigns').update({ deleted_at: new Date().toISOString(), status: 'deleted' }).eq('id', decodeURIComponent(deleteMatch[1])); if (error) throw new Error(error.message); return json(res, 200, { ok: true });
    }
    return json(res, 404, { ok: false, error: 'Admin endpoint not found' });
  } catch (error) { return json(res, error.statusCode || 500, { ok: false, error: error.statusCode ? error.message : 'Server could not complete the request' }); }
}
module.exports = { handleControlPanelApi };

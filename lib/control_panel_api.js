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
  if (!tokens.length) return { sent: 0, failed: 0, message: 'No active FCM tokens are registered yet.' };
  const messaging = getFirebaseAdmin().messaging();
  let sent = 0; let failed = 0;
  for (let i = 0; i < tokens.length; i += 500) {
    const chunk = tokens.slice(i, i + 500);
    const result = await messaging.sendEachForMulticast({
      tokens: chunk.map(x => x.token),
      // Data-only delivery keeps foreground/background behavior consistent:
      // both apps receive the message in their FirebaseMessagingService and
      // can persist/show the campaign dialog themselves.
      data: {
        type: 'ADMIN_CAMPAIGN',
        campaignId: String(campaign.id),
        title: campaign.title || '',
        body: campaign.message || campaign.body || '',
        actionUrl: campaign.action_url || ''
      },
      android: { priority: 'high' }
    });
    sent += result.successCount; failed += result.failureCount;
    const rows = chunk.map((x, index) => ({ campaign_id: campaign.id, device_id: x.device_id, firebase_uid: x.firebase_uid, token: x.token, status: result.responses[index]?.success ? 'sent' : 'failed', sent_at: new Date().toISOString(), error_message: result.responses[index]?.error?.message || null }));
    const deliveryInsert = await db.from('notification_campaign_deliveries').insert(rows);
    if (deliveryInsert.error) console.warn('[ControlPanelAPI] Delivery audit insert failed:', deliveryInsert.error.message);
  }
  return { sent, failed };
}

async function handleControlPanelApi(req, res, url) {
  const path = url.pathname;
  const supported = path === '/api/v1/admin/devices' || path === '/api/v1/admin/pairings' || path === '/api/v1/admin/releases' || path === '/api/v1/admin/campaigns' || path === '/api/v1/admin/settings/maintenance' || path === '/api/v1/admin/monitoring' || /^\/api\/v1\/admin\/campaigns\/[^/]+$/.test(path) || /^\/api\/v1\/admin\/releases\/[^/]+$/.test(path);
  if (!supported || !['GET', 'POST', 'DELETE'].includes(req.method)) return false;
  try {
    const { decoded, adminUser } = await requireApprovedAdmin(req);
    const db = getSupabase();
    if (req.method === 'GET' && path === '/api/v1/admin/devices') {
      const { data, error } = await db.from('device_registry').select('*').order('last_seen_at', { ascending: false }).limit(500);
      if (error) throw new Error(error.message); return json(res, 200, { ok: true, devices: data || [] });
    }
    if (req.method === 'GET' && path === '/api/v1/admin/pairings') {
      const { data, error } = await db.from('pairings').select('*').order('created_at', { ascending: false }).limit(500);
      if (error) throw new Error(error.message); return json(res, 200, { ok: true, pairings: data || [] });
    }
    if (req.method === 'GET' && path === '/api/v1/admin/monitoring') {
      const pairingId = url.searchParams.get('pairingId');
      const childDeviceId = url.searchParams.get('childDeviceId');
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 500);
      const filter = (query) => {
        let q = query;
        if (pairingId) q = q.eq('pairing_id', pairingId);
        if (childDeviceId) q = q.eq('child_device_id', childDeviceId);
        return q.limit(limit);
      };
      const [usage, locations, messages, calls] = await Promise.all([
        filter(db.from('app_usage_daily').select('*').order('usage_date', { ascending: false })),
        filter(db.from('location_events').select('*').order('recorded_at', { ascending: false })),
        filter(db.from('sms_logs').select('*').order('message_timestamp', { ascending: false })),
        filter(db.from('call_logs').select('*').order('call_timestamp', { ascending: false }))
      ]);
      for (const result of [usage, locations, messages, calls]) if (result.error) throw new Error(result.error.message);
      return json(res, 200, { ok: true, usage: usage.data || [], locations: locations.data || [], messages: messages.data || [], calls: calls.data || [] });
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
      let downloadUrl;
      try {
        downloadUrl = new URL(String(body.downloadUrl));
        if (!['http:', 'https:'].includes(downloadUrl.protocol) || ['localhost', '127.0.0.1'].includes(downloadUrl.hostname)) {
          const e = new Error('downloadUrl must be a public http(s) URL reachable from the phone'); e.statusCode = 400; throw e;
        }
      } catch (error) {
        if (error.statusCode) throw error;
        const e = new Error('downloadUrl must be a valid public http(s) URL'); e.statusCode = 400; throw e;
      }
      const appType = String(body.appType || 'CHILD').toUpperCase();
      if (!['PARENT', 'CHILD'].includes(appType)) {
        const e = new Error('appType must be PARENT or CHILD');
        e.statusCode = 400;
        throw e;
      }
      const row = {
        app_type: appType,
        version_name: String(body.versionName),
        version_code: versionCode,
        download_url: downloadUrl.toString(),
        release_notes: String(body.releaseNotes || ''),
        minimum_version_code: body.mandatory ? versionCode : Number(body.minimumVersionCode || body.minimumSupportedVersionCode || 0) || versionCode,
        mandatory: Boolean(body.mandatory),
        is_active: true,
        published_by: decoded.uid,
        published_at: new Date().toISOString()
      };
      const { data, error } = await db.from('app_releases').insert(row).select('*').single(); if (error) throw new Error(error.message);
      await db.from('audit_logs').insert({ admin_firebase_uid: adminUser.firebase_uid || decoded.uid, action: 'APP_RELEASE_PUBLISHED', target_type: 'APP_RELEASE', target_id: String(data.id), new_value: data, reason: body.releaseNotes || null });
      return json(res, 201, { ok: true, release: data });
    }
    if (req.method === 'GET' && path === '/api/v1/admin/campaigns') {
      const { data, error } = await db.from('notification_campaigns').select('*').is('deleted_at', null).order('created_at', { ascending: false }).limit(100);
      if (error) throw new Error(error.message); return json(res, 200, { ok: true, campaigns: data || [] });
    }
    const releaseDeleteMatch = /^\/api\/v1\/admin\/releases\/([^/]+)$/.exec(path);
    if (req.method === 'DELETE' && releaseDeleteMatch) {
      const releaseId = decodeURIComponent(releaseDeleteMatch[1]);
      const existing = await db.from('app_releases').select('id,app_type,version_name,version_code').eq('id', releaseId).maybeSingle();
      if (existing.error) throw new Error(existing.error.message);
      if (!existing.data) {
        const e = new Error('Release not found');
        e.statusCode = 404;
        throw e;
      }
      const deleted = await db.from('app_releases').delete().eq('id', releaseId);
      if (deleted.error) throw new Error(deleted.error.message);
      const audit = await db.from('audit_logs').insert({
        admin_firebase_uid: adminUser.firebase_uid || decoded.uid,
        action: 'APP_RELEASE_DELETED',
        target_type: 'APP_RELEASE',
        target_id: releaseId,
        new_value: existing.data,
        reason: 'Deleted from Admin Panel'
      });
      if (audit.error) console.warn('[ControlPanelAPI] Release delete audit failed:', audit.error.message);
      return json(res, 200, { ok: true, deleted: existing.data });
    }
    if (req.method === 'POST' && path === '/api/v1/admin/campaigns') {
      const body = await parseBody(req);
      const message = String(body.message ?? body.body ?? '').trim();
      if (!body.title || !message) {
        const e = new Error('title and message are required');
        e.statusCode = 400;
        throw e;
      }
      const row = {
        title: String(body.title),
        message,
        action_url: body.actionUrl ? String(body.actionUrl) : null,
        target_plan: String(body.targetPlan || 'ALL'),
        // Do not send an explicit status here. The existing Supabase schema
        // supplies its own valid default; the old explicit values (sending,
        // sent, draft) differ between deployments and can violate the
        // notification_campaigns_status_check constraint.
        created_by: decoded.uid,
        created_at: new Date().toISOString()
      };
      const created = await db.from('notification_campaigns').insert(row).select('*').single(); if (created.error) throw new Error(created.error.message);
      const result = await sendCampaign(created.data, row.target_plan);
      const statusUpdate = await db.from('notification_campaigns').update({ status: 'sent' }).eq('id', created.data.id);
      if (statusUpdate.error) console.warn('[ControlPanelAPI] Campaign status update failed:', statusUpdate.error.message);
      const audit = await db.from('audit_logs').insert({ admin_firebase_uid: adminUser.firebase_uid || decoded.uid, action: 'NOTIFICATION_CAMPAIGN_SENT', target_type: 'CAMPAIGN', target_id: String(created.data.id), new_value: { ...created.data, result }, reason: row.title });
      if (audit.error) console.warn('[ControlPanelAPI] Campaign audit insert failed:', audit.error.message);
      return json(res, 201, { ok: true, campaign: { ...created.data, status: statusUpdate.error ? 'created' : 'sent' }, delivery: result });
    }
    const deleteMatch = /^\/api\/v1\/admin\/campaigns\/([^/]+)$/.exec(path);
    if (req.method === 'DELETE' && deleteMatch) {
      const { error } = await db.from('notification_campaigns').update({ deleted_at: new Date().toISOString(), status: 'deleted' }).eq('id', decodeURIComponent(deleteMatch[1])); if (error) throw new Error(error.message); return json(res, 200, { ok: true });
    }
    return json(res, 404, { ok: false, error: 'Admin endpoint not found' });
  } catch (error) {
    console.error('[ControlPanelAPI]', error);
    return json(res, error.statusCode || 500, {
      ok: false,
      error: error.statusCode ? error.message : 'Server could not complete the request',
      detail: error.message
    });
  }
}
module.exports = { handleControlPanelApi };

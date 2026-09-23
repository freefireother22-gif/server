'use strict';

const { getSupabase, getFirebaseAdmin, verifyFirebaseBearer } = require('./platform');

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
  // The caller uses a boolean to stop the main router. Returning undefined
  // here makes the request fall through and sends a second response.
  return true;
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 2 * 1024 * 1024) {
      const error = new Error('Request body is too large');
      error.statusCode = 413;
      throw error;
    }
  }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (_) {
    const error = new Error('Request body must be valid JSON');
    error.statusCode = 400;
    throw error;
  }
}

async function requireToken(req) {
  return verifyFirebaseBearer(req.headers.authorization);
}

/** Pairing roles are created by the existing Firebase pairing flow. */
async function assertPairingMember(decoded, pairingId, role) {
  if (!pairingId) {
    const error = new Error('pairingId is required'); error.statusCode = 400; throw error;
  }
  const firestore = getFirebaseAdmin().firestore();
  const snap = await firestore.collection('pairings').doc(String(pairingId)).get();
  if (!snap.exists) {
    const error = new Error('Pairing was not found'); error.statusCode = 403; throw error;
  }
  const row = snap.data() || {};
  const expected = role === 'parent' ? row.parentUid : row.childUid;
  if (!expected || expected !== decoded.uid) {
    const error = new Error('The authenticated device is not a member of this pairing');
    error.statusCode = 403;
    throw error;
  }
  return row;
}

function iso(value, fallback = new Date().toISOString()) {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

// Parent clients may be unable to read the legacy Firestore pairing document.
// After device registration, the service-role registry is a second verified
// membership proof for the same Firebase UID and pairing.
async function assertParentAccess(decoded, pairingId) {
  try {
    return await assertPairingMember(decoded, pairingId, 'parent');
  } catch (originalError) {
    if (originalError.statusCode !== 403) throw originalError;
    const { data, error } = await getSupabase()
      .from('device_registry')
      .select('device_id, pairing_id, firebase_uid, role')
      .eq('pairing_id', pairingId)
      .eq('firebase_uid', decoded.uid)
      .eq('role', 'parent')
      .maybeSingle();
    if (!error && data) return data;
    throw originalError;
  }
}

async function upsertDevice(decoded, body, online = true) {
  const deviceId = String(body.deviceId || '').trim();
  if (!deviceId) { const error = new Error('deviceId is required'); error.statusCode = 400; throw error; }
  const role = String(body.role || 'unknown').toLowerCase();
  if (!['parent', 'child', 'unknown'].includes(role)) { const error = new Error('role must be parent or child'); error.statusCode = 400; throw error; }
  const row = {
    device_id: deviceId,
    firebase_uid: decoded.uid,
    role,
    pairing_id: body.pairingId ? String(body.pairingId) : null,
    device_name: body.deviceName ? String(body.deviceName) : null,
    app_version: body.appVersion ? String(body.appVersion) : null,
    platform: body.platform ? String(body.platform) : 'android',
    is_online: online,
    battery_percent: Number.isFinite(Number(body.batteryPercent)) ? Number(body.batteryPercent) : null,
    is_charging: typeof body.isCharging === 'boolean' ? body.isCharging : null,
    last_seen_at: new Date().toISOString()
  };
  const { data, error } = await getSupabase().from('device_registry').upsert(row, { onConflict: 'device_id' }).select('*').single();
  if (error) throw new Error(`Device registry failed: ${error.message}`);
  return data;
}

async function syncSnapshot(decoded, body) {
  const pairingId = String(body.pairingId || '');
  const childDeviceId = String(body.childDeviceId || body.deviceId || '');
  await assertPairingMember(decoded, pairingId, 'child');
  if (!childDeviceId) { const error = new Error('childDeviceId is required'); error.statusCode = 400; throw error; }
  const db = getSupabase();
  const usage = Array.isArray(body.usage) ? body.usage : [];
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const calls = Array.isArray(body.calls) ? body.calls : [];
  const location = body.location || null;
  console.log(
    `[MonitoringAPI] snapshot received pairing=${pairingId} child=${childDeviceId} ` +
    `usage=${usage.length} messages=${messages.length} calls=${calls.length}`
  );
  const today = new Date().toISOString().slice(0, 10);

  if (usage.length) {
    const rows = usage.map(item => ({
      pairing_id: pairingId,
      child_device_id: childDeviceId,
      usage_date: item.usageDate || today,
      package_name: String(item.packageName || 'unknown'),
      app_name: String(item.appName || ''),
      foreground_seconds: Math.max(0, Math.round(Number(item.foregroundMillis || 0) / 1000)),
      last_used_at: item.lastUsedAt ? iso(item.lastUsedAt) : null
    }));
    const result = await db.from('app_usage_daily').upsert(rows, { onConflict: 'child_device_id,usage_date,package_name' });
    if (result.error) throw new Error(`Usage sync failed: ${result.error.message}`);
  }
  if (messages.length) {
    const rows = messages.map(item => ({
      pairing_id: pairingId,
      child_device_id: childDeviceId,
      source_message_id: String(item.id || `${item.address || ''}:${item.timestamp || Date.now()}`),
      address: item.address ? String(item.address) : null,
      body: String(item.body || '').slice(0, 10000),
      direction: String(item.direction || 'received'),
      message_timestamp: iso(item.timestamp)
    }));
    const result = await db.from('sms_logs').upsert(rows, { onConflict: 'child_device_id,source_message_id' });
    if (result.error) throw new Error(`SMS sync failed: ${result.error.message}`);
  }
  if (calls.length) {
    const rows = calls.map(item => ({
      pairing_id: pairingId,
      child_device_id: childDeviceId,
      source_call_id: String(item.id || `${item.phoneNumber || ''}:${item.timestamp || Date.now()}`),
      phone_number: item.phoneNumber ? String(item.phoneNumber) : null,
      contact_name: item.contactName ? String(item.contactName) : null,
      call_type: String(item.callType || 'other'),
      duration_seconds: Math.max(0, Number(item.durationSeconds || 0)),
      call_timestamp: iso(item.timestamp)
    }));
    const result = await db.from('call_logs').upsert(rows, { onConflict: 'child_device_id,source_call_id' });
    if (result.error) throw new Error(`Call sync failed: ${result.error.message}`);
  }
  if (location && Number.isFinite(Number(location.latitude)) && Number.isFinite(Number(location.longitude))) {
    const result = await db.from('location_events').insert({
      pairing_id: pairingId,
      child_device_id: childDeviceId,
      latitude: Number(location.latitude),
      longitude: Number(location.longitude),
      accuracy_meters: location.accuracyMeters == null ? null : Number(location.accuracyMeters),
      recorded_at: iso(location.recordedAt)
    });
    if (result.error) throw new Error(`Location sync failed: ${result.error.message}`);
  }
  await upsertDevice(decoded, { ...body, deviceId: childDeviceId, role: 'child', pairingId }, true);
  const result = { usage: usage.length, messages: messages.length, calls: calls.length, location: Boolean(location) };
  console.log(`[MonitoringAPI] snapshot stored pairing=${pairingId} child=${childDeviceId}`, result);
  return result;
}

async function fetchSnapshot(decoded, url) {
  const pairingId = String(url.searchParams.get('pairingId') || '');
  const childDeviceId = String(url.searchParams.get('childDeviceId') || '');
  await assertParentAccess(decoded, pairingId);
  const db = getSupabase();
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 200, 1), 500);
  const filter = (query) => {
    let q = query.eq('pairing_id', pairingId);
    if (childDeviceId) q = q.eq('child_device_id', childDeviceId);
    return q.limit(limit);
  };
  const [usage, locations, messages, calls] = await Promise.all([
    filter(db.from('app_usage_daily').select('*').order('usage_date', { ascending: false })),
    filter(db.from('location_events').select('*').order('recorded_at', { ascending: false })),
    filter(db.from('sms_logs').select('*').order('message_timestamp', { ascending: false })),
    filter(db.from('call_logs').select('*').order('call_timestamp', { ascending: false }))
  ]);
  for (const result of [usage, locations, messages, calls]) {
    if (result.error) throw new Error(result.error.message);
  }
  return {
    usage: usage.data || [],
    locations: locations.data || [],
    messages: messages.data || [],
    calls: calls.data || []
  };
}

async function handleMonitoringApi(req, res, url) {
  const path = url.pathname;
  const supported = path === '/api/v1/devices/register' || path === '/api/v1/devices/heartbeat' || path === '/api/v1/monitoring/snapshot';
  if (!supported) return false;
  try {
    const decoded = await requireToken(req);
    if (req.method === 'GET' && path === '/api/v1/monitoring/snapshot') {
      return json(res, 200, { ok: true, ...(await fetchSnapshot(decoded, url)) });
    }
    const body = await readJson(req);
    if (req.method === 'POST' && path === '/api/v1/devices/register') return json(res, 200, { ok: true, device: await upsertDevice(decoded, body, true) });
    if (req.method === 'POST' && path === '/api/v1/devices/heartbeat') return json(res, 200, { ok: true, device: await upsertDevice(decoded, body, true) });
    if (req.method === 'POST' && path === '/api/v1/monitoring/snapshot') return json(res, 200, { ok: true, synced: await syncSnapshot(decoded, body) });
  } catch (error) {
    console.error('[MonitoringAPI]', error);
    return json(res, error.statusCode || 500, { ok: false, error: error.statusCode ? error.message : 'Monitoring request failed' });
  }
  return false;
}

module.exports = { handleMonitoringApi };

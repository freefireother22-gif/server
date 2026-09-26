'use strict';

const { getSupabase, getFirebaseAdmin, verifyFirebaseBearer } = require('./platform');
const { requireFeature } = require('./entitlements');

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

// Reinstalling the Child app creates a new anonymous Firebase UID. The
// verified device_registry row is therefore also accepted for Child uploads,
// otherwise an otherwise-valid paired device gets HTTP 403 forever.
async function assertChildAccess(decoded, pairingId, childDeviceId) {
  try {
    return await assertPairingMember(decoded, pairingId, 'child');
  } catch (originalError) {
    const { data, error } = await getSupabase()
      .from('device_registry')
      .select('device_id, pairing_id, firebase_uid, role')
      .eq('pairing_id', pairingId)
      .eq('device_id', childDeviceId)
      .eq('firebase_uid', decoded.uid)
      .eq('role', 'child')
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
  let ownerFirebaseUid = role === 'parent' ? decoded.uid : null;
  if (role === 'child' && body.pairingId) {
    const parent = await getSupabase()
      .from('device_registry')
      .select('owner_firebase_uid, firebase_uid')
      .eq('pairing_id', String(body.pairingId))
      .eq('role', 'parent')
      .maybeSingle();
    if (!parent.error && parent.data) {
      ownerFirebaseUid = parent.data.owner_firebase_uid || parent.data.firebase_uid;
    }
    // The parent device row is shared by multiple child pairings and can be
    // overwritten by the newest pairing before this Child registers. Resolve
    // the verified owner from the pairing document as a reliable fallback.
    if (!ownerFirebaseUid) {
      const pairing = await getFirebaseAdmin().firestore()
        .collection('pairings').doc(String(body.pairingId)).get();
      const pairingData = pairing.exists ? (pairing.data() || {}) : {};
      ownerFirebaseUid = pairingData.parentUid || null;
      // parentDeviceId comes directly from every updated Child snapshot, so
      // ownership repair must not depend on the Firestore document existing.
      const parentDeviceId = body.parentDeviceId || pairingData.parentDeviceId;
      if (!ownerFirebaseUid && parentDeviceId) {
        const parentByDevice = await getSupabase()
          .from('device_registry')
          .select('owner_firebase_uid, firebase_uid')
          .eq('device_id', String(parentDeviceId))
          .eq('role', 'parent')
          .maybeSingle();
        if (!parentByDevice.error && parentByDevice.data) {
          ownerFirebaseUid = parentByDevice.data.owner_firebase_uid ||
            parentByDevice.data.firebase_uid;
        }
      }
    }
    // Never erase a previously verified owner during a later heartbeat when
    // one of the external pairing lookups is temporarily unavailable.
    if (!ownerFirebaseUid) {
      const existingDevice = await getSupabase()
        .from('device_registry')
        .select('owner_firebase_uid')
        .eq('device_id', deviceId)
        .eq('role', 'child')
        .maybeSingle();
      if (!existingDevice.error && existingDevice.data) {
        ownerFirebaseUid = existingDevice.data.owner_firebase_uid || null;
      }
    }
  }
  const row = {
    device_id: deviceId,
    firebase_uid: decoded.uid,
    owner_firebase_uid: ownerFirebaseUid,
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
  if (role === 'child' && ownerFirebaseUid) {
    // Enforce the plan on the server before a new child device is stored.
    const existing = await getSupabase()
      .from('device_registry')
      .select('device_id')
      .eq('device_id', deviceId)
      .eq('owner_firebase_uid', ownerFirebaseUid)
      .eq('role', 'child')
      .maybeSingle();
    if (!existing.data) {
      const { requireDeviceSlot } = require('./entitlements');
      await requireDeviceSlot(ownerFirebaseUid, deviceId);
    }
  }
  const { data, error } = await getSupabase().from('device_registry').upsert(row, { onConflict: 'device_id' }).select('*').single();
  if (error) throw new Error(`Device registry failed: ${error.message}`);
  return data;
}

async function syncSnapshot(decoded, body) {
  const pairingId = String(body.pairingId || '');
  const childDeviceId = String(body.childDeviceId || body.deviceId || '');
  if (!childDeviceId) { const error = new Error('childDeviceId is required'); error.statusCode = 400; throw error; }
  await assertChildAccess(decoded, pairingId, childDeviceId);
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
    // A device can report the same package more than once in one snapshot.
    // Supabase/Postgres rejects an upsert batch when the same conflict key
    // appears twice, so keep only the newest row for each unique key.
    const uniqueRows = new Map();
    usage.forEach(item => {
      const usageDate = item.usageDate || today;
      const packageName = String(item.packageName || 'unknown');
      uniqueRows.set(`${childDeviceId}|${usageDate}|${packageName}`, {
        pairing_id: pairingId,
        child_device_id: childDeviceId,
        usage_date: usageDate,
        package_name: packageName,
        app_name: String(item.appName || ''),
        foreground_seconds: Math.max(0, Math.round(Number(item.foregroundMillis || 0) / 1000)),
        last_used_at: item.lastUsedAt ? iso(item.lastUsedAt) : null
      });
    });
    const rows = [...uniqueRows.values()];
    const result = await db.from('app_usage_daily').upsert(rows, { onConflict: 'child_device_id,usage_date,package_name' });
    if (result.error) throw new Error(`Usage sync failed: ${result.error.message}`);
  }
  if (messages.length) {
    const uniqueRows = new Map();
    messages.forEach(item => {
      const sourceMessageId = String(item.id || `${item.address || ''}:${item.timestamp || Date.now()}`);
      uniqueRows.set(`${childDeviceId}|${sourceMessageId}`, {
        pairing_id: pairingId,
        child_device_id: childDeviceId,
        source_message_id: sourceMessageId,
        address: item.address ? String(item.address) : null,
        body: String(item.body || '').slice(0, 10000),
        direction: String(item.direction || 'received'),
        message_timestamp: iso(item.timestamp)
      });
    });
    const rows = [...uniqueRows.values()];
    const result = await db.from('sms_logs').upsert(rows, { onConflict: 'child_device_id,source_message_id' });
    if (result.error) throw new Error(`SMS sync failed: ${result.error.message}`);
  }
  if (calls.length) {
    const uniqueRows = new Map();
    calls.forEach(item => {
      const sourceCallId = String(item.id || `${item.phoneNumber || ''}:${item.timestamp || Date.now()}`);
      uniqueRows.set(`${childDeviceId}|${sourceCallId}`, {
        pairing_id: pairingId,
        child_device_id: childDeviceId,
        source_call_id: sourceCallId,
        phone_number: item.phoneNumber ? String(item.phoneNumber) : null,
        contact_name: item.contactName ? String(item.contactName) : null,
        call_type: String(item.callType || 'other'),
        duration_seconds: Math.max(0, Number(item.durationSeconds || 0)),
        call_timestamp: iso(item.timestamp)
      });
    });
    const rows = [...uniqueRows.values()];
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
  // Monitoring is a paid parental-control feature. This check is performed
  // on the server so changing the Android client cannot unlock expired users.
  await requireFeature(decoded.uid, 'PARENTAL_CONTROL');
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

async function listOwnedDevices(decoded, url) {
  await requireFeature(decoded.uid, 'PARENTAL_CONTROL');
  const db = getSupabase();
  const activeOnly = url.searchParams.get('activeOnly') === 'true';
  const activeSince = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const parents = await db.from('device_registry')
    .select('*')
    .eq('firebase_uid', decoded.uid)
    .eq('role', 'parent')
    .order('last_seen_at', { ascending: false });
  if (parents.error) throw new Error(parents.error.message);

  // device_registry has one mutable Parent row, while one Parent can own many
  // pairing documents. Build the Child list from the verified Firestore
  // pairings first, then enrich each item with its registry heartbeat. This
  // keeps older paired devices available for switching even when offline.
  const firestore = getFirebaseAdmin().firestore();
  const parentDeviceIds = [...new Set(
    (parents.data || []).map(row => String(row.device_id || '')).filter(Boolean)
  )];
  const pairingSnapshots = await Promise.all([
    firestore.collection('pairings').where('parentUid', '==', decoded.uid).get(),
    ...parentDeviceIds.map(parentDeviceId =>
      firestore.collection('pairings').where('parentDeviceId', '==', parentDeviceId).get()
    )
  ]);
  const pairingById = new Map();
  pairingSnapshots.forEach(snapshot => {
    snapshot.docs.forEach(doc => {
      const value = { id: doc.id, ...(doc.data() || {}) };
      if (value.childDeviceId) pairingById.set(doc.id, value);
    });
  });

  // Registry ownership is retained as a fallback for older pairings created
  // before parentUid was written into every Firestore pairing document.
  const ownedChildren = await db.from('device_registry')
    .select('*')
    .eq('owner_firebase_uid', decoded.uid)
    .eq('role', 'child')
    .not('pairing_id', 'is', null);
  if (ownedChildren.error) throw new Error(ownedChildren.error.message);
  (ownedChildren.data || []).forEach(row => {
    const pairingId = String(row.pairing_id || '');
    if (pairingId && !pairingById.has(pairingId)) {
      pairingById.set(pairingId, {
        id: pairingId,
        pairingId,
        childDeviceId: row.device_id,
        childDeviceName: row.device_name
      });
    }
  });

  const pairings = [...pairingById.values()];
  const childIds = [...new Set(pairings.map(pairing => String(pairing.childDeviceId)))];

  let registryRows = [];
  if (childIds.length) {
    const children = await db.from('device_registry')
      .select('*')
      .in('device_id', childIds);
    if (children.error) throw new Error(children.error.message);
    registryRows = children.data || [];
  }
  const registryByDeviceId = new Map(
    registryRows.map(row => [String(row.device_id), row])
  );
  const now = Date.now();
  const childDevices = pairings.map(pairing => {
    const deviceId = String(pairing.childDeviceId);
    const registered = registryByDeviceId.get(deviceId) || {};
    const lastSeenAt = registered.last_seen_at || null;
    const heartbeatIsRecent = lastSeenAt
      ? now - new Date(lastSeenAt).getTime() <= 10 * 60 * 1000
      : false;
    return {
      ...registered,
      device_id: deviceId,
      firebase_uid: registered.firebase_uid || pairing.childUid || null,
      owner_firebase_uid: decoded.uid,
      role: 'child',
      pairing_id: String(pairing.pairingId || pairing.id),
      device_name: registered.device_name || pairing.childDeviceName || pairing.childModel || 'Child phone',
      is_online: Boolean(registered.is_online && heartbeatIsRecent),
      last_seen_at: lastSeenAt
    };
  }).filter(device => !activeOnly || (
    device.is_online && device.last_seen_at && device.last_seen_at >= activeSince
  ));

  console.log(
    `[MonitoringAPI] owned devices parent=${decoded.uid.slice(0, 8)} ` +
    `children=${childDevices.length} ids=${childDevices.map(row => row.device_id).join(',')}`
  );
  return { devices: [...(parents.data || []), ...childDevices] };
}

async function handleMonitoringApi(req, res, url) {
  const path = url.pathname;
  const supported = path === '/api/v1/devices/register' || path === '/api/v1/devices/heartbeat' ||
    path === '/api/v1/devices' || path === '/api/v1/monitoring/snapshot';
  if (!supported) return false;
  try {
    const decoded = await requireToken(req);
    if (req.method === 'GET' && path === '/api/v1/devices') {
      return json(res, 200, { ok: true, ...(await listOwnedDevices(decoded, url)) });
    }
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

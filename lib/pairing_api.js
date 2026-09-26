'use strict';

const crypto = require('crypto');
const { getSupabase, getFirebaseAdmin, verifyFirebaseBearer } = require('./platform');
const { requireDeviceSlot } = require('./entitlements');

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
  return true;
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64 * 1024) { const e = new Error('Request body is too large'); e.statusCode = 413; throw e; }
  }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (_) { const e = new Error('Invalid JSON'); e.statusCode = 400; throw e; }
}

const hashCode = (code) => crypto.createHash('sha256').update(String(code)).digest('hex');
const validCode = (value) => /^\d{6}$/.test(String(value || ''));

function publicPairing(row) {
  if (!row || !row.pairing_id) return null;
  return {
    pairingId: row.pairing_id,
    parentAccountId: row.parent_account_id,
    parentDeviceId: row.parent_device_id,
    parentEmail: row.parent_email || '',
    childDeviceId: row.child_device_id,
    childDeviceName: row.child_device_name || 'Child Device',
    childModel: row.child_model || 'Android Phone',
    createdAt: row.used_at ? new Date(row.used_at).getTime() : Date.now(),
    lastSeen: Date.now(),
    isOnline: true
  };
}

async function createOtp(decoded, body) {
  const parentDeviceId = String(body.parentDeviceId || '').trim();
  if (!parentDeviceId) { const e = new Error('parentDeviceId is required'); e.statusCode = 400; throw e; }
  const db = getSupabase();
  const device = await db.from('device_registry').select('device_id, firebase_uid, role')
    .eq('device_id', parentDeviceId).eq('firebase_uid', decoded.uid).eq('role', 'parent').maybeSingle();
  if (device.error) throw new Error(device.error.message);
  if (!device.data) { const e = new Error('Parent device is not registered for this Firebase account'); e.statusCode = 403; throw e; }

  const code = String(crypto.randomInt(100000, 1000000));
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  await db.from('pairing_otps').delete().eq('parent_device_id', parentDeviceId).is('used_at', null);
  const row = {
    code_hash: hashCode(code),
    parent_firebase_uid: decoded.uid,
    parent_account_id: String(body.parentAccountId || decoded.uid),
    parent_device_id: parentDeviceId,
    parent_email: String(decoded.email || body.parentEmail || ''),
    expires_at: expiresAt
  };
  const inserted = await db.from('pairing_otps').insert(row).select('expires_at').single();
  if (inserted.error) throw new Error(`Unable to create pairing code: ${inserted.error.message}`);
  return { code, expiresAt: new Date(inserted.data.expires_at).getTime() };
}

async function redeemOtp(decoded, body) {
  const code = String(body.code || '').trim();
  const childDeviceId = String(body.childDeviceId || '').trim();
  if (!validCode(code) || !childDeviceId) { const e = new Error('Invalid or Expired OTP'); e.statusCode = 400; throw e; }
  const db = getSupabase();
  const found = await db.from('pairing_otps').select('*').eq('code_hash', hashCode(code)).maybeSingle();
  if (found.error) throw new Error(found.error.message);
  const otp = found.data;
  if (!otp || otp.used_at || new Date(otp.expires_at).getTime() <= Date.now()) {
    const e = new Error('Invalid or Expired OTP'); e.statusCode = 400; throw e;
  }

  await requireDeviceSlot(otp.parent_firebase_uid, childDeviceId);
  const pairingId = `pair_${crypto.randomBytes(6).toString('hex')}`;
  const now = new Date().toISOString();
  const childDeviceName = String(body.childDeviceName || 'Child Device').slice(0, 160);
  const childModel = String(body.childModel || 'Android Phone').slice(0, 160);
  const claimed = await db.from('pairing_otps').update({
    used_at: now,
    child_firebase_uid: decoded.uid,
    child_device_id: childDeviceId,
    child_device_name: childDeviceName,
    child_model: childModel,
    pairing_id: pairingId
  }).eq('code_hash', otp.code_hash).is('used_at', null).select('*').maybeSingle();
  if (claimed.error) throw new Error(claimed.error.message);
  if (!claimed.data) { const e = new Error('Invalid or Expired OTP'); e.statusCode = 409; throw e; }

  const childRow = {
    device_id: childDeviceId,
    firebase_uid: decoded.uid,
    owner_firebase_uid: otp.parent_firebase_uid,
    role: 'child',
    pairing_id: pairingId,
    device_name: childDeviceName,
    platform: 'android',
    is_online: true,
    last_seen_at: now
  };
  const childUpsert = await db.from('device_registry').upsert(childRow, { onConflict: 'device_id' });
  if (childUpsert.error) throw new Error(`Unable to register Child device: ${childUpsert.error.message}`);
  const parentUpdate = await db.from('device_registry').update({ pairing_id: pairingId, owner_firebase_uid: otp.parent_firebase_uid, last_seen_at: now })
    .eq('device_id', otp.parent_device_id).eq('firebase_uid', otp.parent_firebase_uid).eq('role', 'parent');
  if (parentUpdate.error) throw new Error(`Unable to update Parent device: ${parentUpdate.error.message}`);

  await getFirebaseAdmin().firestore().collection('pairings').doc(pairingId).set({
    pairingId,
    parentUid: otp.parent_firebase_uid,
    childUid: decoded.uid,
    parentDeviceId: otp.parent_device_id,
    childDeviceId,
    childDeviceName,
    childModel,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }, { merge: true });
  return publicPairing(claimed.data);
}

async function getStatus(decoded, url) {
  const code = String(url.searchParams.get('code') || '').trim();
  if (!validCode(code)) { const e = new Error('Invalid OTP'); e.statusCode = 400; throw e; }
  const result = await getSupabase().from('pairing_otps').select('*')
    .eq('code_hash', hashCode(code)).eq('parent_firebase_uid', decoded.uid).maybeSingle();
  if (result.error) throw new Error(result.error.message);
  if (!result.data) { const e = new Error('Pairing code was not found'); e.statusCode = 404; throw e; }
  return { paired: Boolean(result.data.used_at && result.data.pairing_id), pairing: publicPairing(result.data) };
}

async function handlePairingApi(req, res, url) {
  const path = url.pathname;
  const supported = path === '/api/v1/pairing/otp' || path === '/api/v1/pairing/otp/redeem' || path === '/api/v1/pairing/otp/status';
  if (!supported) return false;
  try {
    const decoded = await verifyFirebaseBearer(req.headers.authorization);
    if (req.method === 'POST' && path === '/api/v1/pairing/otp') return json(res, 201, { ok: true, ...(await createOtp(decoded, await readJson(req))) });
    if (req.method === 'POST' && path === '/api/v1/pairing/otp/redeem') return json(res, 200, { ok: true, pairing: await redeemOtp(decoded, await readJson(req)) });
    if (req.method === 'GET' && path === '/api/v1/pairing/otp/status') return json(res, 200, { ok: true, ...(await getStatus(decoded, url)) });
    return json(res, 405, { ok: false, error: 'Method not allowed' });
  } catch (error) {
    console.error('[PairingAPI]', error.message);
    return json(res, error.statusCode || 500, { ok: false, error: error.statusCode ? error.message : 'Pairing request failed' });
  }
}

module.exports = { handlePairingApi };

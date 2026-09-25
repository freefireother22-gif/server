'use strict';

const { getSupabase } = require('./platform');

const TRIAL_MS = 3 * 24 * 60 * 60 * 1000;
const VALID_PLANS = new Set(['TRIAL', 'FREE', 'PRO', 'PREMIUM']);
const PREMIUM_FEATURES = [
  'SCREEN_SHARING',
  'SCREEN_MIRRORING',
  'REMOTE_CAMERA',
  'ONE_WAY_AUDIO',
  'APP_LOCKING',
  'CALL_LOGS',
  'MESSAGE_LOGS',
  'APP_USAGE',
  'LIVE_LOCATION',
  'MAP_LOCATION',
  'PARENTAL_CONTROL'
];

const DEFAULT_CONFIG = {
  TRIAL: { durationDays: 3, maxChildDevices: 1 },
  FREE: { durationDays: 0, maxChildDevices: 0 },
  PRO: { durationDays: 30, maxChildDevices: 3 },
  PREMIUM: { durationDays: 365, maxChildDevices: 10 }
};

function normalizePlan(value) {
  const plan = String(value || '').toUpperCase();
  return VALID_PLANS.has(plan) ? plan : 'FREE';
}

function defaultFeatures(plan) {
  const enabled = plan !== 'FREE';
  return Object.fromEntries(PREMIUM_FEATURES.map((name) => [name, enabled]));
}

async function getPlanConfig(plan) {
  const normalized = normalizePlan(plan);
  const fallback = DEFAULT_CONFIG[normalized];
  const { data, error } = await getSupabase()
    .from('plan_config')
    .select('*')
    .eq('plan', normalized)
    .maybeSingle();
  if (error) {
    // Existing installations may not have migration 006 yet. Keep the API
    // usable with safe defaults while the migration is being applied.
    console.warn('[Entitlements] plan_config read failed:', error.message);
    return { plan: normalized, ...fallback, features: defaultFeatures(normalized) };
  }
  return {
    plan: normalized,
    durationDays: Number(data?.duration_days ?? fallback.durationDays),
    maxChildDevices: Number(data?.max_child_devices ?? fallback.maxChildDevices),
    features: {
      ...defaultFeatures(normalized),
      ...(data?.features && typeof data.features === 'object' ? data.features : {})
    }
  };
}

async function findUser(firebaseUid) {
  const { data, error } = await getSupabase()
    .from('users')
    .select('*')
    .eq('firebase_uid', firebaseUid)
    .maybeSingle();
  if (error) throw new Error(`Unable to load user: ${error.message}`);
  return data;
}

async function expireIfNeeded(user) {
  if (!user) return null;
  const plan = normalizePlan(user.plan);
  const expiry = plan === 'TRIAL' ? user.trial_ends_at : user.subscription_ends_at;
  if (!expiry || new Date(expiry).getTime() > Date.now()) return user;
  const { data, error } = await getSupabase()
    .from('users')
    .update({
      plan: 'FREE',
      subscription_started_at: null,
      subscription_ends_at: null
    })
    .eq('firebase_uid', user.firebase_uid)
    .select('*')
    .single();
  if (error) throw new Error(`Unable to expire plan: ${error.message}`);
  await getSupabase().from('subscriptions').update({ active: false })
    .eq('firebase_uid', user.firebase_uid).eq('active', true);
  return data;
}

async function getEntitlement(firebaseUid) {
  const freshUser = await expireIfNeeded(await findUser(firebaseUid));
  if (!freshUser) return null;
  const plan = normalizePlan(freshUser.plan);
  const config = await getPlanConfig(plan);
  const expiry = plan === 'TRIAL' ? freshUser.trial_ends_at : freshUser.subscription_ends_at;
  const active = freshUser.account_status === 'ACTIVE' &&
    plan !== 'FREE' &&
    (!expiry || new Date(expiry).getTime() > Date.now());
  const features = Object.fromEntries(
    PREMIUM_FEATURES.map((name) => [name, active && config.features[name] !== false])
  );
  return {
    user: freshUser,
    plan,
    active,
    expiry,
    maxChildDevices: Math.max(0, config.maxChildDevices),
    features
  };
}

function publicEntitlement(entitlement) {
  if (!entitlement) return null;
  const now = Date.now();
  const { user, plan, active, expiry, maxChildDevices, features } = entitlement;
  const trialRemainingMs = plan === 'TRIAL' && expiry
    ? Math.max(0, new Date(expiry).getTime() - now)
    : 0;
  return {
    firebaseUid: user.firebase_uid,
    email: user.email,
    displayName: user.display_name,
    photoUrl: user.photo_url,
    plan,
    accountStatus: user.account_status,
    trialStartedAt: user.trial_started_at,
    trialEndsAt: user.trial_ends_at,
    trialRemainingSeconds: Math.floor(trialRemainingMs / 1000),
    subscriptionStartedAt: user.subscription_started_at,
    subscriptionEndsAt: user.subscription_ends_at,
    active,
    maxChildDevices,
    features: {
      basic: user.account_status === 'ACTIVE',
      pro: active && ['TRIAL', 'PRO', 'PREMIUM'].includes(plan),
      premium: active && plan === 'PREMIUM',
      ...features
    },
    // Keep the existing app contract intact.
    hasProAccess: active && ['TRIAL', 'PRO', 'PREMIUM'].includes(plan),
    hasPremiumAccess: active && plan === 'PREMIUM'
  };
}

async function requireFeature(firebaseUid, feature) {
  const entitlement = await getEntitlement(firebaseUid);
  if (!entitlement || !entitlement.active || entitlement.features[feature] !== true) {
    const error = new Error('Please get a paid plan to use this feature.');
    error.statusCode = 403;
    error.code = 'PAID_PLAN_REQUIRED';
    throw error;
  }
  return entitlement;
}

async function countChildDevices(firebaseUid) {
  const { data, error } = await getSupabase()
    .from('device_registry')
    .select('device_id')
    .eq('owner_firebase_uid', firebaseUid)
    .eq('role', 'child');
  if (error) throw new Error(`Unable to count child devices: ${error.message}`);
  return new Set((data || []).map((row) => row.device_id)).size;
}

async function requireDeviceSlot(firebaseUid, deviceId) {
  const entitlement = await getEntitlement(firebaseUid);
  if (!entitlement || !entitlement.active) {
    const error = new Error('Please get a paid plan to connect a child device.');
    error.statusCode = 403;
    error.code = 'PAID_PLAN_REQUIRED';
    throw error;
  }
  const current = await countChildDevices(firebaseUid);
  const alreadyRegistered = await getSupabase()
    .from('device_registry')
    .select('device_id')
    .eq('device_id', deviceId)
    .eq('owner_firebase_uid', firebaseUid)
    .eq('role', 'child')
    .maybeSingle();
  if (!alreadyRegistered.data && current >= entitlement.maxChildDevices) {
    const error = new Error('Your current plan has reached its child-device limit.');
    error.statusCode = 403;
    error.code = 'DEVICE_LIMIT_REACHED';
    throw error;
  }
  return entitlement;
}

async function assignPlan(firebaseUid, plan, endsAt, source = 'ADMIN', note = '') {
  const normalized = normalizePlan(plan);
  const now = new Date();
  const config = await getPlanConfig(normalized);
  let expiry = endsAt || null;
  if (normalized === 'TRIAL') expiry = expiry || new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString();
  if (normalized === 'PRO' || normalized === 'PREMIUM') {
    const days = config.durationDays || (normalized === 'PREMIUM' ? 365 : 30);
    expiry = expiry || new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
  }
  const updates = {
    plan: normalized,
    subscription_started_at: normalized === 'PRO' || normalized === 'PREMIUM' ? now.toISOString() : null,
    subscription_ends_at: normalized === 'PRO' || normalized === 'PREMIUM' ? expiry : null,
    trial_started_at: normalized === 'TRIAL' ? now.toISOString() : null,
    trial_ends_at: normalized === 'TRIAL' ? expiry : null
  };
  const { data, error } = await getSupabase().from('users')
    .update(updates).eq('firebase_uid', firebaseUid).select('*').single();
  if (error) throw new Error(`Unable to assign plan: ${error.message}`);
  await getSupabase().from('subscriptions').update({ active: false })
    .eq('firebase_uid', firebaseUid).eq('active', true);
  if (normalized !== 'FREE') {
    await getSupabase().from('subscriptions').insert({
      firebase_uid: firebaseUid,
      plan: normalized,
      source,
      starts_at: now.toISOString(),
      ends_at: expiry,
      active: true,
      note: note || null
    });
  }
  return data;
}

async function redeemForUser(firebaseUid, rawCode) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) {
    const error = new Error('Redeem code is required.');
    error.statusCode = 400;
    error.code = 'REDEEM_CODE_REQUIRED';
    throw error;
  }
  const db = getSupabase();
  const { data: redeem, error: readError } = await db.from('redeem_codes')
    .select('*').eq('code', code).maybeSingle();
  if (readError) throw new Error(`Unable to validate redeem code: ${readError.message}`);
  if (!redeem || !redeem.active) {
    const error = new Error('This redeem code is invalid or disabled.');
    error.statusCode = 400; error.code = 'REDEEM_CODE_INVALID'; throw error;
  }
  if (redeem.expires_at && new Date(redeem.expires_at).getTime() <= Date.now()) {
    const error = new Error('This redeem code has expired.');
    error.statusCode = 400; error.code = 'REDEEM_CODE_EXPIRED'; throw error;
  }
  if (Number(redeem.used_count || 0) >= Number(redeem.max_uses || 1)) {
    const error = new Error('This redeem code has already been used.');
    error.statusCode = 400; error.code = 'REDEEM_CODE_USED'; throw error;
  }
  const { data: existing } = await db.from('redeem_code_redemptions')
    .select('id').eq('code_id', redeem.id).eq('firebase_uid', firebaseUid).maybeSingle();
  if (existing) {
    const error = new Error('You have already used this redeem code.');
    error.statusCode = 400; error.code = 'REDEEM_CODE_ALREADY_USED'; throw error;
  }

  const plan = normalizePlan(redeem.plan);
  const days = Number(redeem.duration_days ?? redeem.extra_days ?? 0) ||
    (plan === 'PREMIUM' ? 365 : plan === 'PRO' ? 30 : plan === 'TRIAL' ? 3 : 0);
  const endsAt = days > 0
    ? new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
    : null;
  const updated = await assignPlan(firebaseUid, plan, endsAt, 'REDEEM', redeem.note || `Redeemed ${code}`);
  const { data: claimed, error: claimError } = await db.from('redeem_codes')
    .update({ used_count: Number(redeem.used_count || 0) + 1 })
    .eq('id', redeem.id).eq('used_count', Number(redeem.used_count || 0))
    .select('*').maybeSingle();
  if (claimError || !claimed) {
    const error = new Error('This redeem code was claimed by another request. Please try again.');
    error.statusCode = 409; error.code = 'REDEEM_CODE_RACE'; throw error;
  }
  await db.from('redeem_code_redemptions').insert({
    code_id: redeem.id, firebase_uid: firebaseUid, plan, ends_at: endsAt
  });
  return updated;
}

module.exports = {
  PREMIUM_FEATURES,
  DEFAULT_CONFIG,
  VALID_PLANS,
  TRIAL_MS,
  getPlanConfig,
  getEntitlement,
  publicEntitlement,
  requireFeature,
  requireDeviceSlot,
  assignPlan,
  redeemForUser
};
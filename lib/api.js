'use strict';

const { getSupabase, getFirebaseAdmin, verifyFirebaseBearer } = require('./platform');
const { handleControlPanelApi } = require('./control_panel_api');
const { handleDeviceApi } = require('./device_api');
const { handleUpdatePolicy } = require('./update_policy');
const { handleMonitoringApi } = require('./monitoring_api');
const { handlePromoBannerApi } = require('./promo_banner_api');
const {
  DEFAULT_CONFIG,
  PREMIUM_FEATURES,
  getEntitlement,
  publicEntitlement,
  redeemForUser,
  assignPlan,
  getPlanConfig,
  requireFeature
} = require('./entitlements');

const VALID_PLANS = new Set(['TRIAL', 'FREE', 'PRO', 'PREMIUM']);
const VALID_STATUSES = new Set(['ACTIVE', 'SUSPENDED', 'BANNED']);
const TRIAL_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 1024 * 1024;

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  const configured = (process.env.ADMIN_ALLOWED_ORIGINS || 'http://localhost:3000,http://localhost:5173')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (origin && configured.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        const error = new Error('Request body is too large');
        error.statusCode = 413;
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (_) {
        const error = new Error('Request body must be valid JSON');
        error.statusCode = 400;
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

async function requireFirebaseUser(req) {
  const decoded = await verifyFirebaseBearer(req.headers.authorization);
  if (!decoded.uid || !decoded.email || decoded.email_verified !== true) {
    const error = new Error('A verified Google email is required');
    error.statusCode = 403;
    throw error;
  }

  const providers = Array.isArray(decoded.firebase?.sign_in_provider)
    ? decoded.firebase.sign_in_provider
    : [decoded.firebase?.sign_in_provider];
  if (!providers.includes('google.com')) {
    const error = new Error('Google Sign-In is required');
    error.statusCode = 403;
    throw error;
  }
  return decoded;
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

async function getOrCreateUser(decoded) {
  const supabase = getSupabase();
  let user = await findUser(decoded.uid);
  const now = new Date();

  if (!user) {
    const trialEndsAt = new Date(now.getTime() + TRIAL_MS).toISOString();
    const { data, error } = await supabase
      .from('users')
      .insert({
        firebase_uid: decoded.uid,
        email: decoded.email.toLowerCase(),
        display_name: decoded.name || decoded.email.split('@')[0],
        photo_url: decoded.picture || null,
        plan: 'TRIAL',
        account_status: 'ACTIVE',
        trial_started_at: now.toISOString(),
        trial_ends_at: trialEndsAt,
        last_login_at: now.toISOString()
      })
      .select('*')
      .single();
    if (error) throw new Error(`Unable to create user: ${error.message}`);
    user = data;

    await supabase.from('subscriptions').insert({
      firebase_uid: decoded.uid,
      plan: 'TRIAL',
      source: 'TRIAL',
      starts_at: now.toISOString(),
      ends_at: trialEndsAt,
      active: true,
      note: 'Automatic 3-day trial on first verified Google login'
    });
  } else {
    const { data, error } = await supabase
      .from('users')
      .update({
        email: decoded.email.toLowerCase(),
        display_name: decoded.name || user.display_name,
        photo_url: decoded.picture || user.photo_url,
        last_login_at: now.toISOString()
      })
      .eq('firebase_uid', decoded.uid)
      .select('*')
      .single();
    if (error) throw new Error(`Unable to update user login: ${error.message}`);
    user = data;
  }

  return applyPlanExpiry(user);
}

async function applyPlanExpiry(user) {
  const now = Date.now();
  let expired = false;

  if (user.plan === 'TRIAL' && user.trial_ends_at) {
    expired = new Date(user.trial_ends_at).getTime() <= now;
  }
  if ((user.plan === 'PRO' || user.plan === 'PREMIUM') && user.subscription_ends_at) {
    expired = new Date(user.subscription_ends_at).getTime() <= now;
  }
  if (!expired) return user;

  const { data, error } = await getSupabase()
    .from('users')
    .update({ plan: 'FREE', subscription_ends_at: null })
    .eq('firebase_uid', user.firebase_uid)
    .select('*')
    .single();
  if (error) throw new Error(`Unable to expire plan: ${error.message}`);
  return data;
}

function publicUser(user) {
  const now = Date.now();
  const trialRemainingMs = user.plan === 'TRIAL' && user.trial_ends_at
    ? Math.max(0, new Date(user.trial_ends_at).getTime() - now)
    : 0;
  return {
    firebaseUid: user.firebase_uid,
    email: user.email,
    displayName: user.display_name,
    photoUrl: user.photo_url,
    plan: user.plan,
    accountStatus: user.account_status,
    trialStartedAt: user.trial_started_at,
    trialEndsAt: user.trial_ends_at,
    trialRemainingSeconds: Math.floor(trialRemainingMs / 1000),
    subscriptionStartedAt: user.subscription_started_at,
    subscriptionEndsAt: user.subscription_ends_at,
    features: {
      basic: user.account_status === 'ACTIVE',
      pro: user.account_status === 'ACTIVE' && ['TRIAL', 'PRO', 'PREMIUM'].includes(user.plan),
      premium: user.account_status === 'ACTIVE' && user.plan === 'PREMIUM'
    }
  };
}

function assertAccountAllowed(user) {
  if (user.account_status === 'BANNED') {
    const error = new Error('This account has been banned');
    error.statusCode = 403;
    error.code = 'ACCOUNT_BANNED';
    throw error;
  }
  if (user.account_status === 'SUSPENDED') {
    const error = new Error('This account is suspended');
    error.statusCode = 403;
    error.code = 'ACCOUNT_SUSPENDED';
    throw error;
  }
}

async function requireAdmin(decoded) {
  const supabase = getSupabase();
  let query = await supabase
    .from('admin_users')
    .select('*')
    .eq('firebase_uid', decoded.uid)
    .eq('active', true)
    .maybeSingle();
  if (query.error) throw new Error(`Unable to verify administrator: ${query.error.message}`);

  let adminUser = query.data;
  if (!adminUser && decoded.email) {
    query = await supabase
      .from('admin_users')
      .select('*')
      .eq('email', decoded.email.toLowerCase())
      .eq('active', true)
      .maybeSingle();
    if (query.error) throw new Error(`Unable to verify administrator: ${query.error.message}`);
    adminUser = query.data;

    if (adminUser && !adminUser.firebase_uid) {
      const linked = await supabase
        .from('admin_users')
        .update({ firebase_uid: decoded.uid })
        .eq('id', adminUser.id)
        .select('*')
        .single();
      if (!linked.error) adminUser = linked.data;
    }
  }

  if (!adminUser) {
    const error = new Error('Administrator access is not approved');
    error.statusCode = 403;
    error.code = 'ADMIN_NOT_APPROVED';
    throw error;
  }
  return adminUser;
}

async function writeAudit(adminUser, action, targetType, targetId, oldValue, newValue, reason) {
  const { error } = await getSupabase().from('audit_logs').insert({
    admin_firebase_uid: adminUser.firebase_uid,
    action,
    target_type: targetType,
    target_id: targetId,
    old_value: oldValue || null,
    new_value: newValue || null,
    reason: reason || null
  });
  if (error) console.warn('[AdminAPI] Audit log failed:', error.message);
}

async function getCount(table, filters = []) {
  let query = getSupabase().from(table).select('id', { count: 'exact', head: true });
  for (const [column, value] of filters) query = query.eq(column, value);
  const { count, error } = await query;
  if (error) throw new Error(`Unable to count ${table}: ${error.message}`);
  return count || 0;
}

async function handleApi(req, res, url) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }

  if (await handleUpdatePolicy(req, res, url)) return true;
  if (await handleDeviceApi(req, res, url)) return true;
  if (await handleMonitoringApi(req, res, url)) return true;
  if (await handlePromoBannerApi(req, res, url)) return true;
  if (await handleControlPanelApi(req, res, url)) return true;

  const path = url.pathname;
  if (!path.startsWith('/api/')) return false;

  try {
    const decoded = await requireFirebaseUser(req);

    if (req.method === 'POST' && path === '/api/v1/auth/session') {
      const user = await getOrCreateUser(decoded);
      assertAccountAllowed(user);
      sendJson(res, 200, { ok: true, user: publicEntitlement(await getEntitlement(decoded.uid)) });
      return true;
    }

    if (req.method === 'GET' && path === '/api/v1/me') {
      const user = await getOrCreateUser(decoded);
      assertAccountAllowed(user);
      sendJson(res, 200, { ok: true, user: publicEntitlement(await getEntitlement(decoded.uid)) });
      return true;
    }

    if (req.method === 'GET' && path === '/api/v1/entitlements') {
      const user = await getOrCreateUser(decoded);
      assertAccountAllowed(user);
      sendJson(res, 200, { ok: true, user: publicEntitlement(await getEntitlement(decoded.uid)) });
      return true;
    }

    if (req.method === 'POST' && path === '/api/v1/redeem') {
      const user = await getOrCreateUser(decoded);
      assertAccountAllowed(user);
      const body = await readJson(req);
      const updated = await redeemForUser(decoded.uid, body.code);
      sendJson(res, 200, {
        ok: true,
        user: publicEntitlement(await getEntitlement(updated.firebase_uid))
      });
      return true;
    }

    if (req.method === 'POST' && path === '/api/v1/feature/authorize') {
      const user = await getOrCreateUser(decoded);
      assertAccountAllowed(user);
      const body = await readJson(req);
      const feature = String(body.feature || '').toUpperCase();
      const entitlement = await requireFeature(decoded.uid, feature);
      sendJson(res, 200, {
        ok: true,
        feature,
        plan: entitlement.plan,
        maxChildDevices: entitlement.maxChildDevices
      });
      return true;
    }

    const adminUser = await requireAdmin(decoded);

    if (req.method === 'GET' && path === '/api/v1/admin/dashboard') {
      const usersQuery = await getSupabase()
        .from('users')
        .select('firebase_uid, plan, account_status');
      if (usersQuery.error) throw new Error(`Unable to count users: ${usersQuery.error.message}`);
      const userRows = usersQuery.data || [];
      const allUsers = userRows.length;
      const activeUsers = userRows.filter((row) => String(row.account_status || '').toUpperCase() === 'ACTIVE').length;
      const bannedUsers = userRows.filter((row) => String(row.account_status || '').toUpperCase() === 'BANNED').length;
      const proUsers = userRows.filter((row) => String(row.plan || '').toUpperCase() === 'PRO').length;
      const premiumUsers = userRows.filter((row) => String(row.plan || '').toUpperCase() === 'PREMIUM').length;
      const trialUsers = userRows.filter((row) => String(row.plan || '').toUpperCase() === 'TRIAL').length;
      const devicesQuery = await getSupabase()
        .from('device_registry')
        .select('device_id', { count: 'exact', head: true });
      const devices = devicesQuery.error ? 0 : (devicesQuery.count || 0);
      sendJson(res, 200, {
        ok: true,
        dashboard: { allUsers, activeUsers, bannedUsers, proUsers, trialUsers, paidUsers: proUsers + premiumUsers, devices }
      });
      return true;
    }

    if (req.method === 'GET' && path === '/api/v1/admin/users') {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 100);
      const { data, error } = await getSupabase()
        .from('users')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw new Error(`Unable to list users: ${error.message}`);
      const users = await Promise.all(data.map(async (item) => {
        const entitlement = await getEntitlement(item.firebase_uid);
        return entitlement ? publicEntitlement(entitlement) : publicUser(item);
      }));
      sendJson(res, 200, { ok: true, users });
      return true;
    }

    let match = /^\/api\/v1\/admin\/users\/([^/]+)$/.exec(path);
    if (req.method === 'DELETE' && match) {
      const targetUid = decodeURIComponent(match[1]);
      if (targetUid === adminUser.firebase_uid) {
        const error = new Error('You cannot delete the currently signed-in administrator');
        error.statusCode = 400;
        throw error;
      }

      const oldUser = await findUser(targetUid);
      if (!oldUser) {
        const error = new Error('User not found');
        error.statusCode = 404;
        throw error;
      }

      const db = getSupabase();
      // Remove data owned directly by the account before removing the user row.
      // These deletes are intentionally best-effort because older deployments
      // may not have every optional table.
      for (const [table, column] of [
        ['device_fcm_tokens', 'firebase_uid'],
        ['device_registry', 'firebase_uid'],
        ['device_registry', 'owner_firebase_uid'],
        ['subscriptions', 'firebase_uid'],
        ['redeem_code_redemptions', 'firebase_uid']
      ]) {
        const result = await db.from(table).delete().eq(column, targetUid);
        if (result.error && !/does not exist|schema cache/i.test(result.error.message)) {
          throw new Error(`Unable to delete ${table} records: ${result.error.message}`);
        }
      }

      const deleted = await db.from('users').delete().eq('firebase_uid', targetUid).select('*').maybeSingle();
      if (deleted.error) throw new Error(`Unable to delete user: ${deleted.error.message}`);

      try {
        await getFirebaseAdmin().auth().deleteUser(targetUid);
      } catch (error) {
        // The database record is already removed; an already-removed Firebase
        // user is a successful end state.
        if (error?.code !== 'auth/user-not-found') throw error;
      }

      await writeAudit(
        adminUser,
        'USER_DELETED',
        'USER',
        targetUid,
        publicUser(oldUser),
        null,
        'Deleted from Admin Panel'
      );
      sendJson(res, 200, { ok: true, deletedUid: targetUid });
      return true;
    }

    match = /^\/api\/v1\/admin\/users\/([^/]+)\/plan$/.exec(path);
    if (req.method === 'PATCH' && match) {
      const targetUid = decodeURIComponent(match[1]);
      const body = await readJson(req);
      const plan = String(body.plan || '').toUpperCase();
      if (!VALID_PLANS.has(plan)) {
        const error = new Error('plan must be TRIAL, FREE, PRO or PREMIUM');
        error.statusCode = 400;
        throw error;
      }

      const oldUser = await findUser(targetUid);
      if (!oldUser) {
        const error = new Error('User not found');
        error.statusCode = 404;
        throw error;
      }

      const data = await assignPlan(
        targetUid,
        plan,
        body.endsAt || null,
        'ADMIN',
        body.reason || 'Plan changed from Admin Panel'
      );
      await writeAudit(
        adminUser,
        'USER_PLAN_CHANGED',
        'USER',
        targetUid,
        publicUser(oldUser),
        publicEntitlement(await getEntitlement(targetUid)),
        body.reason
      );
      sendJson(res, 200, {
        ok: true,
        user: publicEntitlement(await getEntitlement(targetUid))
      });
      return true;
    }

    if (req.method === 'GET' && path === '/api/v1/admin/plan-config') {
      const rows = await Promise.all(
        ['TRIAL', 'FREE', 'PRO', 'PREMIUM'].map((plan) => getPlanConfig(plan))
      );
      sendJson(res, 200, { ok: true, plans: rows });
      return true;
    }

    if (req.method === 'PATCH' && path === '/api/v1/admin/plan-config') {
      const body = await readJson(req);
      const plan = String(body.plan || '').toUpperCase();
      if (!DEFAULT_CONFIG[plan]) {
        const error = new Error('Unknown plan');
        error.statusCode = 400;
        throw error;
      }
      const durationDays = Math.max(0, Number(body.durationDays ?? DEFAULT_CONFIG[plan].durationDays));
      const maxChildDevices = Math.max(0, Number(body.maxChildDevices ?? DEFAULT_CONFIG[plan].maxChildDevices));
      const features = Object.fromEntries(
        PREMIUM_FEATURES.map((feature) => [feature, body.features?.[feature] !== false])
      );
      const { data, error } = await getSupabase().from('plan_config')
        .upsert({
          plan,
          duration_days: durationDays,
          max_child_devices: maxChildDevices,
          features,
          updated_by: adminUser.firebase_uid,
          updated_at: new Date().toISOString()
        }, { onConflict: 'plan' }).select('*').single();
      if (error) throw new Error(`Unable to update plan config: ${error.message}`);
      await writeAudit(adminUser, 'PLAN_CONFIG_CHANGED', 'PLAN', plan, null, data, body.reason);
      sendJson(res, 200, { ok: true, plan: await getPlanConfig(plan) });
      return true;
    }

    if (req.method === 'GET' && path === '/api/v1/admin/redeem-codes') {
      const { data, error } = await getSupabase().from('redeem_codes')
        .select('*').order('created_at', { ascending: false }).limit(500);
      if (error) throw new Error(`Unable to list redeem codes: ${error.message}`);
      sendJson(res, 200, { ok: true, codes: data || [] });
      return true;
    }

    if (req.method === 'POST' && path === '/api/v1/admin/redeem-codes') {
      const body = await readJson(req);
      const code = String(body.code || '').trim().toUpperCase();
      const plan = String(body.plan || 'PRO').toUpperCase();
      if (!code || !DEFAULT_CONFIG[plan]) {
        const error = new Error('code and a valid plan are required');
        error.statusCode = 400;
        throw error;
      }
      const durationDays = Math.max(
        0,
        Number(body.durationDays ?? body.extraDays ?? DEFAULT_CONFIG[plan].durationDays)
      );
      const { data, error } = await getSupabase().from('redeem_codes').insert({
        code,
        plan,
        duration_days: durationDays,
        max_uses: Math.max(1, Number(body.maxUses || 1)),
        expires_at: body.expiresAt || null,
        note: body.note ? String(body.note) : null,
        created_by: adminUser.firebase_uid
      }).select('*').single();
      if (error) {
        const duplicate = String(error.message || '').toLowerCase().includes('duplicate');
        const e = new Error(duplicate ? 'This redeem code already exists.' : error.message);
        e.statusCode = duplicate ? 409 : 400;
        throw e;
      }
      await writeAudit(adminUser, 'REDEEM_CODE_CREATED', 'REDEEM_CODE', String(data.id), null, data, body.note);
      sendJson(res, 201, { ok: true, code: data });
      return true;
    }

    match = /^\/api\/v1\/admin\/redeem-codes\/([^/]+)$/.exec(path);
    if (req.method === 'DELETE' && match) {
      const id = decodeURIComponent(match[1]);
      const { data, error } = await getSupabase().from('redeem_codes')
        .update({ active: false, updated_at: new Date().toISOString() })
        .eq('id', id).select('*').single();
      if (error) throw new Error(`Unable to revoke redeem code: ${error.message}`);
      await writeAudit(adminUser, 'REDEEM_CODE_REVOKED', 'REDEEM_CODE', id, null, data, 'Revoked from Admin Panel');
      sendJson(res, 200, { ok: true, code: data });
      return true;
    }

    match = /^\/api\/v1\/admin\/users\/([^/]+)\/status$/.exec(path);
    if (req.method === 'PATCH' && match) {
      const targetUid = decodeURIComponent(match[1]);
      const body = await readJson(req);
      const status = String(body.status || '').toUpperCase();
      if (!VALID_STATUSES.has(status)) {
        const error = new Error('status must be ACTIVE, SUSPENDED or BANNED');
        error.statusCode = 400;
        throw error;
      }
      if (!body.reason || String(body.reason).trim().length < 3) {
        const error = new Error('A reason is required for account status changes');
        error.statusCode = 400;
        throw error;
      }

      const oldUser = await findUser(targetUid);
      if (!oldUser) {
        const error = new Error('User not found');
        error.statusCode = 404;
        throw error;
      }
      const { data, error } = await getSupabase()
        .from('users')
        .update({ account_status: status })
        .eq('firebase_uid', targetUid)
        .select('*')
        .single();
      if (error) throw new Error(`Unable to update account status: ${error.message}`);

      await writeAudit(adminUser, 'USER_STATUS_CHANGED', 'USER', targetUid, publicUser(oldUser), publicUser(data), body.reason);
      sendJson(res, 200, { ok: true, user: publicUser(data) });
      return true;
    }

    sendJson(res, 404, { ok: false, error: 'API endpoint not found' });
    return true;
  } catch (error) {
    const statusCode = error.statusCode || 500;
    if (statusCode >= 500) console.error('[AdminAPI]', error);
    sendJson(res, statusCode, {
      ok: false,
      code: error.code || (statusCode === 500 ? 'SERVER_ERROR' : 'REQUEST_REJECTED'),
      error: statusCode === 500 ? 'Server could not complete the request' : error.message
    });
    return true;
  }
}

module.exports = { handleApi, sendJson };

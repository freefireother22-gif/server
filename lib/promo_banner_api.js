'use strict';

const { getSupabase, verifyFirebaseBearer } = require('./platform');

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(body));
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 256 * 1024) {
        const error = new Error('Request body is too large');
        error.statusCode = 413;
        reject(error);
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (_) { const error = new Error('Invalid JSON'); error.statusCode = 400; reject(error); }
    });
    req.on('error', reject);
  });
}

async function requireAdmin(req) {
  const decoded = await verifyFirebaseBearer(req.headers.authorization);
  if (!decoded.email || decoded.email_verified !== true || decoded.firebase?.sign_in_provider !== 'google.com') {
    const error = new Error('Verified Google Admin account required');
    error.statusCode = 403;
    throw error;
  }
  const db = getSupabase();
  let result = await db.from('admin_users').select('*').eq('firebase_uid', decoded.uid).eq('active', true).maybeSingle();
  if (result.error) throw new Error(result.error.message);
  let admin = result.data;
  if (!admin) {
    result = await db.from('admin_users').select('*').eq('email', decoded.email.toLowerCase()).eq('active', true).maybeSingle();
    if (result.error) throw new Error(result.error.message);
    admin = result.data;
    if (admin && !admin.firebase_uid) {
      const linked = await db.from('admin_users').update({ firebase_uid: decoded.uid }).eq('id', admin.id).select('*').single();
      if (!linked.error) admin = linked.data;
    }
  }
  if (!admin) {
    const error = new Error('Administrator access is not approved');
    error.statusCode = 403;
    throw error;
  }
  return { decoded, admin };
}

function cleanBanner(body) {
  const title = String(body.title || '').trim();
  const message = String(body.body ?? body.message ?? '').trim();
  const buttonText = String(body.buttonText ?? body.button_text ?? 'Upgrade').trim() || 'Upgrade';
  const targetPlan = String(body.targetPlan ?? body.target_plan ?? 'ALL').trim().toUpperCase() || 'ALL';
  const displayOrder = Number.isInteger(Number(body.displayOrder ?? body.display_order))
    ? Number(body.displayOrder ?? body.display_order) : 0;
  if (!title || title.length > 80) throw Object.assign(new Error('title is required and must be 80 characters or less'), { statusCode: 400 });
  if (!message || message.length > 220) throw Object.assign(new Error('body is required and must be 220 characters or less'), { statusCode: 400 });
  if (!['ALL', 'TRIAL', 'FREE', 'PRO', 'PREMIUM'].includes(targetPlan)) throw Object.assign(new Error('Invalid targetPlan'), { statusCode: 400 });
  return {
    title,
    body: message,
    button_text: buttonText.slice(0, 30),
    action_url: body.actionUrl || body.action_url ? String(body.actionUrl ?? body.action_url).trim().slice(0, 500) : null,
    target_plan: targetPlan,
    display_order: Math.max(0, Math.min(9999, displayOrder)),
    is_active: body.isActive === undefined && body.is_active === undefined ? true : Boolean(body.isActive ?? body.is_active)
  };
}

function publicBanner(row) {
  return {
    id: String(row.id),
    title: row.title || '',
    body: row.body || '',
    buttonText: row.button_text || 'Upgrade',
    actionUrl: row.action_url || '',
    targetPlan: row.target_plan || 'ALL',
    displayOrder: row.display_order || 0,
    isActive: row.is_active !== false
  };
}

async function handlePromoBannerApi(req, res, url) {
  const path = url.pathname;
  const adminCollection = path === '/api/v1/admin/promo-banners';
  const adminItem = /^\/api\/v1\/admin\/promo-banners\/([^/]+)$/.exec(path);
  const parentCollection = path === '/api/v1/content/promo-banners';
  if (!adminCollection && !adminItem && !parentCollection) return false;
  try {
    const db = getSupabase();
    if (parentCollection && req.method === 'GET') {
      const decoded = await verifyFirebaseBearer(req.headers.authorization);
      if (!decoded.uid) { const error = new Error('Authentication required'); error.statusCode = 401; throw error; }
      const userResult = await db.from('users').select('plan,account_status').eq('firebase_uid', decoded.uid).maybeSingle();
      if (userResult.error) throw new Error(userResult.error.message);
      const plan = userResult.data?.plan || 'TRIAL';
      const result = await db.from('promo_banners').select('id,title,body,button_text,action_url,target_plan,display_order,is_active')
        .eq('is_active', true).is('deleted_at', null).order('display_order', { ascending: true }).order('created_at', { ascending: true }).limit(50);
      if (result.error) throw new Error(result.error.message);
      const banners = (result.data || []).filter(row => row.target_plan === 'ALL' || row.target_plan === plan).map(publicBanner);
      return json(res, 200, { ok: true, banners });
    }
    const { decoded, admin } = await requireAdmin(req);
    if (adminCollection && req.method === 'GET') {
      const result = await db.from('promo_banners').select('*').is('deleted_at', null).order('display_order', { ascending: true }).order('created_at', { ascending: true }).limit(200);
      if (result.error) throw new Error(result.error.message);
      return json(res, 200, { ok: true, banners: result.data || [] });
    }
    if (adminCollection && req.method === 'POST') {
      const body = await readBody(req);
      const row = { ...cleanBanner(body), created_by: decoded.uid, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      const result = await db.from('promo_banners').insert(row).select('*').single();
      if (result.error) throw new Error(result.error.message);
      return json(res, 201, { ok: true, banner: result.data });
    }
    if (adminItem && ['PATCH', 'PUT'].includes(req.method)) {
      const body = await readBody(req);
      const row = { ...cleanBanner(body), updated_at: new Date().toISOString(), updated_by: decoded.uid };
      const result = await db.from('promo_banners').update(row).eq('id', decodeURIComponent(adminItem[1])).is('deleted_at', null).select('*').single();
      if (result.error) throw new Error(result.error.message);
      return json(res, 200, { ok: true, banner: result.data });
    }
    if (adminItem && req.method === 'DELETE') {
      const result = await db.from('promo_banners').update({ deleted_at: new Date().toISOString(), is_active: false, updated_by: decoded.uid, updated_at: new Date().toISOString() }).eq('id', decodeURIComponent(adminItem[1])).is('deleted_at', null);
      if (result.error) throw new Error(result.error.message);
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { ok: false, error: 'Method not allowed' });
  } catch (error) {
    console.error('[PromoBannerAPI]', error);
    return json(res, error.statusCode || 500, { ok: false, error: error.statusCode ? error.message : 'Promo banner request failed', detail: error.message });
  }
}

module.exports = { handlePromoBannerApi };

'use strict';
const { getSupabase } = require('./platform');
function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }
async function handleUpdatePolicy(req, res, url) {
  if (req.method !== 'GET' || url.pathname !== '/api/v1/app/update-policy') return false;
  try {
    const platform = String(url.searchParams.get('platform') || 'android');
    const versionCode = Number(url.searchParams.get('versionCode') || 0);
    if (platform !== 'android') return json(res, 200, { ok: true, maintenanceMode: false, updateRequired: false });
    const db = getSupabase();
    const settings = await db.from('app_control_settings').select('*').eq('id', true).maybeSingle();
    if (settings.error && settings.error.code !== 'PGRST116') throw new Error(settings.error.message);
    const maintenance = settings.data || {};
    const { data, error } = await db.from('app_releases').select('*').eq('is_active', true).order('version_code', { ascending: false }).limit(1).maybeSingle();
    if (error) throw new Error(error.message);
    if (maintenance.maintenance_mode) return json(res, 200, { ok: true, maintenanceMode: true, maintenanceTitle: maintenance.maintenance_title, maintenanceMessage: maintenance.maintenance_message, maintenanceUntil: maintenance.maintenance_until, updateRequired: false });
    if (!data) return json(res, 200, { ok: true, maintenanceMode: false, updateRequired: false });
    const minimum = Number(data.minimum_supported_version_code || 0);
    const latest = Number(data.version_code || 0);
    return json(res, 200, { ok: true, maintenanceMode: false, updateRequired: versionCode > 0 && versionCode < minimum, latestVersionName: data.version_name, latestVersionCode: latest, minimumSupportedVersionCode: minimum, mandatory: Boolean(data.mandatory), downloadUrl: data.download_url, releaseNotes: data.release_notes || '' });
  } catch (_) { return json(res, 503, { ok: false, code: 'UPDATE_POLICY_UNAVAILABLE' }); }
}
module.exports = { handleUpdatePolicy };

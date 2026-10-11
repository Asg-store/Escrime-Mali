// ════════════════════════════════════════════════════════════════
//  MgLoot — /api/fx-update   (💱 taux USD automatique) — version Supabase
//  Écrit config/shop.rateUsd (et rateXof fixe). Cron Vercel 1×/jour.
// ════════════════════════════════════════════════════════════════
const L = require('./_supabase.js');
const EUR_XOF = 655.957;
const USD_MIN = 0.5, USD_MAX = 3;

async function fetchEurUsd() {
  try {
    const r = await fetch('https://api.frankfurter.app/latest?from=EUR&to=USD', { headers: { Accept: 'application/json' } });
    const j = await r.json().catch(() => ({}));
    const v = +(((j || {}).rates || {}).USD);
    if (isFinite(v) && v >= USD_MIN && v <= USD_MAX) return { rate: v, src: 'frankfurter' };
  } catch (e) {}
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/EUR', { headers: { Accept: 'application/json' } });
    const j = await r.json().catch(() => ({}));
    const v = +(((j || {}).rates || {}).USD);
    if (isFinite(v) && v >= USD_MIN && v <= USD_MAX) return { rate: v, src: 'er-api' };
  } catch (e) {}
  return null;
}

async function runUpdate() {
  const got = await fetchEurUsd();
  if (!got) return { ok: false, error: 'Aucune source de taux disponible' };
  const rateUsd = Math.round(got.rate * 10000) / 10000;
  // Fusionne dans config/shop.data (sans écraser le reste)
  const { data: cur } = await L.supa().from('config').select('data').eq('id', 'shop').maybeSingle();
  const merged = Object.assign({}, cur && cur.data, { rateUsd, rateXof: EUR_XOF, fxUpdatedAt: new Date().toISOString(), fxSource: got.src });
  await L.supa().from('config').upsert({ id: 'shop', data: merged });
  return { ok: true, rateUsd, rateXof: EUR_XOF, source: got.src };
}

module.exports = async (req, res) => {
  L.cors(res, 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const secret = process.env.CRON_SECRET || '';
  const auth = String((req.headers && (req.headers.authorization || req.headers.Authorization)) || '');
  let ok = L.isInternal(req);
  if (!ok && secret) ok = (auth === 'Bearer ' + secret);
  if (!ok && !secret) ok = true;
  if (!ok) { try { const u = await L.getAuthUser(req); ok = !!(u && u.isAdmin); } catch (e) {} }
  if (!ok) return res.status(403).json({ error: 'Accès refusé' });
  try { return res.status(200).json(await runUpdate()); }
  catch (e) { console.error('[fx-update]', e); return res.status(200).json({ ok: false, error: e.message }); }
};

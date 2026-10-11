// ════════════════════════════════════════════════════════════════
//  MgLoot — /api/flashtopup-services  (CATALOGUE FazerCards) — version Supabase
//  Inchangé sauf l'auth admin (via _supabase.js). FazerCards reste identique.
// ════════════════════════════════════════════════════════════════
const FZR_BASE = (process.env.FAZERCARDS_BASE_URL || 'https://api.fzr.cards/api/v2').replace(/\/+$/, '');
const FZR_KEY = (process.env.FAZERCARDS_API_KEY || '').trim();
const L = require('./_supabase.js');
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

async function fzr(endpoint) {
  const r = await fetch(FZR_BASE + endpoint, { headers: { 'X-API-Key': FZR_KEY, 'Accept': 'application/json' } });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { http: r.status, data: j };
}
function pickList(d) {
  if (Array.isArray(d)) return d;
  d = d || {};
  return d.items || d.data || d.categories || d.topups || d.results || d.offers || [];
}
const gVal = (o, keys) => { for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k]; return ''; };

module.exports = async (req, res) => {
  const wantJson = req.query && (req.query.format === 'json' || req.query.json === '1');
  const cat = (req.query && (req.query.cat || req.query.category_id) || '').trim();

  let allowed = L.adminToolOk(req);
  if (!allowed) { try { const u = await L.getAuthUser(req); allowed = !!(u && u.isAdmin); } catch (e) {} }
  if (!allowed) {
    if (wantJson) return res.status(403).json({ error: 'Accès refusé' });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(403).send('<h3>🔒 Accès refusé — ouvrez le catalogue depuis l\'admin (bouton « Catalogue FazerCards »), ou ajoutez ?key=VOTRE_ADMIN_TOOL_KEY à l\'adresse.</h3>');
  }
  if (!FZR_KEY) {
    if (wantJson) return res.status(200).json({ error: 'FAZERCARDS_API_KEY manquant (variable Vercel)' });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send('<h3>❌ FAZERCARDS_API_KEY manquant (variable Vercel)</h3>');
  }

  try {
    if (wantJson) {
      if (req.query.validations === '1') {
        const r = await fzr('/topups/validate-id');
        const list = pickList(r.data).map(g => ({ name: gVal(g, ['name', 'title', 'label']), category_id: gVal(g, ['category_id', 'id', 'categoryId', 'category']), fields: (g && (g.fields || g.required_fields)) || [] })).filter(g => g.category_id);
        return res.status(200).json({ ok: true, validations: list, http: r.http, raw: list.length ? undefined : JSON.stringify(r.data).slice(0, 500) });
      }
      if (cat) {
        const r = await fzr('/topups/offers?category_id=' + encodeURIComponent(cat));
        const d = r.data || {};
        const offers = pickList(d).map(o => ({ name: gVal(o, ['name', 'title', 'label']), offer_id: gVal(o, ['offer_id', 'id', 'offerId', 'offer']), price_usd: gVal(o, ['price_usd', 'price', 'priceUsd', 'amount']) }));
        return res.status(200).json({ ok: true, name: (d && d.name) || cat, category_id: cat, offers, http: r.http, raw: offers.length ? undefined : JSON.stringify(r.data).slice(0, 500) });
      }
      const r = await fzr('/topups?limit=500');
      const games = pickList(r.data).map(g => ({ name: gVal(g, ['name', 'title', 'label']), category_id: gVal(g, ['category_id', 'id', 'categoryId', 'category']) })).filter(g => g.category_id);
      return res.status(200).json({ ok: true, games, http: r.http, raw: games.length ? undefined : JSON.stringify(r.data).slice(0, 500) });
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const K = '&key=' + encodeURIComponent(String(req.query.key || ''));
    const style = '<style>body{font-family:system-ui;background:#0b0b0d;color:#eee;padding:16px}a{color:#00b0ff}code{background:#1c1c22;padding:2px 6px;border-radius:6px;color:#e8c766}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #333;padding:8px;text-align:left;font-size:13px}h2{color:#e8c766}</style>';
    if (cat) {
      const r = await fzr('/topups/offers?category_id=' + encodeURIComponent(cat));
      const d = r.data || {};
      const offers = (d.offers || []);
      let html = style + '<h2>🎮 ' + esc(d.name || cat) + '</h2><p>category_id : <code>' + esc(cat) + '</code></p><p><a href="/api/flashtopup-services?x=1' + K + '">← Tous les jeux</a></p>';
      html += '<table><tr><th>Offre</th><th>offer_id (à copier)</th><th>Prix USD</th></tr>';
      offers.forEach(function (o) { html += '<tr><td>' + esc(o.name) + '</td><td><code>' + esc(o.offer_id) + '</code></td><td>' + esc(o.price_usd || '') + '</td></tr>'; });
      html += '</table>';
      if (!offers.length) html += '<p>Aucune offre (HTTP ' + esc(r.http) + ').</p>';
      return res.status(200).send(html);
    }
    const r = await fzr('/topups?limit=500');
    const d = r.data || {};
    const items = (d.items || []);
    let html = style + '<h2>🎮 Jeux FazerCards (recharges)</h2><p>Cliquez un jeu pour voir ses offres et copier les IDs.</p>';
    html += '<table><tr><th>Jeu</th><th>category_id</th><th>Offres</th></tr>';
    items.forEach(function (g) { html += '<tr><td>' + esc(g.name) + '</td><td><code>' + esc(g.category_id) + '</code></td><td><a href="/api/flashtopup-services?cat=' + encodeURIComponent(g.category_id) + K + '">voir les offres →</a></td></tr>'; });
    html += '</table>';
    if (!items.length) html += '<p>Aucun jeu (HTTP ' + esc(r.http) + ').</p>';
    return res.status(200).send(html);
  } catch (e) {
    if (wantJson) return res.status(200).json({ error: e.message });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send('<h3>❌ ' + esc(e.message) + '</h3>');
  }
};

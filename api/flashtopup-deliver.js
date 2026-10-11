// ════════════════════════════════════════════════════════════════
//  MgLoot — /api/flashtopup-deliver  — version Supabase
//  Livraison automatique via FazerCards. Lit/écrit la commande dans Supabase.
//  Body (POST JSON) : { orderId }
// ════════════════════════════════════════════════════════════════
const L = require('./_supabase.js');
const sb = () => L.supa();

const FZR_BASE = (process.env.FAZERCARDS_BASE_URL || 'https://api.fzr.cards/api/v2').replace(/\/+$/, '');
const FZR_KEY = (process.env.FAZERCARDS_API_KEY || '').trim();

async function fzr(method, endpoint, body, idem) {
  const headers = { 'X-API-Key': FZR_KEY, 'Accept': 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  if (idem) headers['Idempotency-Key'] = idem;
  const res = await fetch(FZR_BASE + endpoint, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch (e) { json = null; }
  return { http: res.status, ok: !!(json && json.ok) && res.status < 400, data: json };
}
const DONE = ['completed', 'success', 'delivered', 'done'];
const FAILED = ['failed', 'error', 'cancelled', 'canceled', 'refunded', 'rejected'];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function mailMod() { try { return require('./_email.js'); } catch (e) { return { sendEmail: async () => false, wrap: (x) => x }; } }

// Fusionne la ligne Supabase en objet « commande » plat
function toOrder(row) {
  if (!row) return null;
  return Object.assign({}, row.data, { items: row.items || [], status: row.status, userId: row.user_id, total: row.total });
}
async function getProductData(id) { const { data } = await sb().from('products').select('data').eq('id', id).maybeSingle(); return data ? (data.data || {}) : {}; }

module.exports = async (req, res) => {
  L.cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    if (!FZR_KEY) return res.status(500).json({ error: 'FAZERCARDS_API_KEY manquant (variable Vercel)' });
    let payload = L.body(req);
    const orderId = (payload && payload.orderId || '').trim();
    if (!orderId) return res.status(400).json({ error: 'orderId requis' });

    const { data: row } = await sb().from('orders').select('*').eq('id', orderId).maybeSingle();
    if (!row) return res.status(404).json({ error: 'Commande introuvable' });
    const order = toOrder(row);

    if (!L.isInternal(req)) {
      const user = await L.getAuthUser(req);
      if (!user) return res.status(401).json({ error: 'Non authentifié' });
      if (!user.isAdmin && user.uid !== order.userId) return res.status(403).json({ error: 'Accès refusé' });
    }

    if (order.ftStatus === 'success') return res.status(200).json({ ok: true, note: 'déjà livrée' });
    if (['paid', 'delivered', 'processing', 'shipped'].indexOf(order.status) < 0) return res.status(400).json({ error: 'Commande non payée (statut: ' + (order.status || '—') + ')' });

    const acc = order.account || {};
    const target = String(order.playerId || acc.userId || acc.konamiId || acc.player_id || acc.user_id || acc.uid || acc.character_id || '').trim();
    const serverId = String(order.serverId || acc.serverId || acc.server_id || '').trim();
    const DYN = acc._dyn === true;
    const dynFields = {};
    if (DYN) { Object.keys(acc).forEach(function (k) { if (k === '_dyn' || k === 'serverId') return; const v = acc[k]; if (v != null && String(v).trim() !== '') dynFields[k] = String(v).trim(); }); }
    if (!target && !(DYN && Object.keys(dynFields).length)) return res.status(400).json({ error: 'ID joueur manquant sur la commande' });

    let defaultCat = '';
    try { const { data: cfg } = await sb().from('config').select('data').eq('id', 'shop').maybeSingle(); defaultCat = String((cfg && cfg.data && cfg.data.fzrDefaultCat) || '').trim(); } catch (e) {}

    const items = order.items || [];
    const tasks = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      let cat = it.fzrCat || '', offer = it.fzrOffer || '';
      if ((!cat || !offer) && it.id) { const pd = await getProductData(it.id); cat = cat || pd.fzrCat || ''; offer = offer || pd.fzrOffer || ''; }
      if (!cat && defaultCat) cat = defaultCat;
      if (!cat || !offer) continue;
      const qty = Math.max(1, it.qty || 1);
      for (let q = 0; q < qty; q++) tasks.push({ cat, offer, idem: orderId + '-' + i + '-' + q });
    }
    if (!tasks.length) return res.status(400).json({ error: 'Aucun article mappé (renseignez category_id + offer_id FazerCards dans l\'admin)' });

    const orders = [];
    for (let t = 0; t < tasks.length; t++) {
      let fields;
      if (DYN) { fields = Object.assign({}, dynFields); if (!Object.keys(fields).length && target) fields.player_id = target; }
      else { fields = { player_id: target }; if (serverId) fields.server_id = serverId; }
      const r = await fzr('POST', '/topups/order', { category_id: tasks[t].cat, offer_id: tasks[t].offer, fields }, tasks[t].idem);
      const o = (r.data && r.data.order) || {};
      orders.push({ id: o.id || '', status: String(o.status || (r.ok ? 'processing' : 'failed')).toLowerCase(), ok: r.ok, msg: (r.data && r.data.error) || '', code: r.ok ? '' : ('HTTP_' + r.http) });
    }

    let allDone = false;
    for (let attempt = 0; attempt < 19 && !allDone; attempt++) {
      await sleep(3000);
      allDone = true;
      for (let k = 0; k < orders.length; k++) {
        if (DONE.indexOf(orders[k].status) >= 0 || FAILED.indexOf(orders[k].status) >= 0) continue;
        if (!orders[k].id) { allDone = false; continue; }
        const s = await fzr('GET', '/orders/' + encodeURIComponent(orders[k].id));
        const so = (s.data && s.data.order) || {};
        if (so.status) orders[k].status = String(so.status).toLowerCase();
        if (DONE.indexOf(orders[k].status) < 0 && FAILED.indexOf(orders[k].status) < 0) allDone = false;
      }
    }

    const anyFailed = orders.some(r => FAILED.indexOf(r.status) >= 0 || (!r.ok && !r.id));
    const allSuccess = orders.length > 0 && orders.every(r => DONE.indexOf(r.status) >= 0);

    const dataPatch = {
      ftRefs: orders.map(r => r.id), ftLastStatus: orders.map(r => r.status).join(','),
      ftProvider: 'fazercards', ftCheckedAt: new Date().toISOString()
    };
    let statusCol = row.status;
    if (allSuccess) { statusCol = 'delivered'; dataPatch.ftStatus = 'success'; dataPatch.deliveredAt = new Date().toISOString(); }
    else if (anyFailed) { dataPatch.ftStatus = 'failed'; }
    else { dataPatch.ftStatus = 'pending'; }
    const problem = orders.find(r => r.code || FAILED.indexOf(r.status) >= 0);
    if (problem) dataPatch.ftError = ((problem.code ? problem.code + ': ' : '') + (problem.msg || '')).slice(0, 300);
    await sb().from('orders').update({ status: statusCol, data: Object.assign({}, row.data, dataPatch) }).eq('id', orderId);

    if (allSuccess && order.userId) {
      const cref = 'CMD-' + String(orderId).slice(0, 6).toUpperCase();
      const bodyTxt = 'Votre recharge (' + cref + ') a été livrée automatiquement sur l\'ID ' + target + '.';
      let gameImg = '';
      try {
        const it0 = (order.items || [])[0] || {};
        let pd = {};
        if (it0.id) pd = await getProductData(it0.id);
        const gkey = pd.game || '';
        if (gkey) { const { data: gs } = await sb().from('games').select('data').eq('id', gkey).maybeSingle(); gameImg = String((gs && gs.data && gs.data.logoUrl) || ''); }
        if (!gameImg) gameImg = String(pd.imageUrl || '');
      } catch (e) {}
      try { await sb().from('notifications').insert({ user_id: order.userId, icon: '✅', title: 'Commande livrée !', body: bodyTxt, type: 'order', link: 'payments', read: false, data: { refId: orderId, image: gameImg } }); } catch (e) {}
      try { await L.pushTo(order.userId, '✅ Commande livrée !', bodyTxt, 'order', gameImg ? { image: gameImg } : {}); } catch (e) {}
      try {
        const em = order.email || '';
        if (em) {
          const M = mailMod();
          const list = (order.items || []).map(it => '• ' + (it.qty || 1) + '× ' + L.esc(it.name || '')).join('<br>');
          const html = M.wrap('<h2 style="color:#e8c766;margin:0 0 10px">✅ Commande livrée</h2>'
            + '<p>Bonjour ' + L.esc(order.userName || '') + ',</p>'
            + '<p>Votre commande <b>' + cref + '</b> a été livrée automatiquement.</p>'
            + '<div style="background:#141418;border-radius:10px;padding:14px;margin:12px 0">'
            + (list ? ('<b>Articles :</b><br>' + list + '<br><br>') : '')
            + '<b>ID joueur :</b> ' + L.esc(target) + '<br><b>Total :</b> ' + Math.round((+order.total || 0) * L.EUR_XOF).toLocaleString('fr-FR') + ' FCFA'
            + '</div><p>Merci pour votre confiance ! 🎮</p>');
          await M.sendEmail(em, 'Commande ' + cref + ' livrée — MgLoot', html);
        }
      } catch (e) {}
    }

    return res.status(200).json({ ok: true, orderId, delivered: allSuccess, status: allSuccess ? 'delivered' : (anyFailed ? 'failed' : 'pending'), error: problem ? ((problem.code ? problem.code + ': ' : '') + (problem.msg || '')) : null, orders });
  } catch (e) {
    console.error('[deliver]', e);
    return res.status(500).json({ error: e.message });
  }
};

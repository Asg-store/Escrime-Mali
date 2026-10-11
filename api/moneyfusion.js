// ════════════════════════════════════════════════════════════════
//  MgLoot — /api/moneyfusion  — version Supabase
//  create / status / timeout / webhook + cron de réconciliation.
//  🔒 Le statut MoneyFusion est TOUJOURS revérifié avant tout crédit.
//  Le crédit/livraison passe par la RPC atomique mf_apply_paid.
// ════════════════════════════════════════════════════════════════
const L = require('./_supabase.js');
const crypto = require('crypto');
const sb = () => L.supa();

const MF_URL = (process.env.MONEYFUSION_API_URL || 'https://pay.moneyfusion.net/MGLOOT/6084012c0199a6de/pay/');
const MF_VERIFY_CANDIDATES = (process.env.MONEYFUSION_VERIFY_URL
  ? [process.env.MONEYFUSION_VERIFY_URL]
  : ['https://pay.moneyfusion.net/paiementNotif/', 'https://www.pay.moneyfusion.net/paiementNotif/', 'https://api.moneyfusion.net/paiementNotif/']
).map(u => u.replace(/\/*$/, '/'));
const WALLET_MAX_EUR = 2000;
const PLUS_DAYS = { m1: 30, m3: 90, m12: 365 };
const PLUS_NAMES = { 7: 'Bronze', 8: 'Améthyste', 9: 'Émeraude', 10: 'Bleu vérifié' };
const MF_TIMEOUT_MS = 13 * 60 * 1000;

function isPaidStatus(s) {
  s = String(s || '').toLowerCase().trim();
  return s === 'paid' || s === 'success' || s === 'completed' || s === 'succes' || s === 'réussi' || s === 'reussi';
}
async function mfVerify(token) {
  const attempts = [];
  for (const base of MF_VERIFY_CANDIDATES) {
    try {
      const t0 = Date.now();
      const r = await fetch(base + encodeURIComponent(token), { headers: { 'Accept': 'application/json' } });
      let j = {}; try { j = await r.json(); } catch (e) { j = {}; }
      const dd = (j && j.data && typeof j.data === 'object') ? j.data : j;
      const statut = (dd && (dd.statut || dd.status)) || null;
      const num = (v) => { const n = +String(v == null ? '' : v).replace(/[^\d.]/g, ''); return isFinite(n) && n > 0 ? n : 0; };
      const montant = dd ? num(dd.Montant != null ? dd.Montant : (dd.montant != null ? dd.montant : dd.totalPrice)) : 0;
      const frais = dd ? num(dd.frais != null ? dd.frais : dd.Frais) : 0;
      const amount = montant ? montant + frais : null;
      attempts.push({ base, httpStatus: r.status, statut, ms: Date.now() - t0 });
      if (statut != null || r.ok) return { ok: true, statut, amount, via: base, attempts };
    } catch (e) { attempts.push({ base, error: (e && e.message) || 'fetch failed' }); }
  }
  return { ok: false, statut: null, amount: null, via: null, attempts };
}

async function getPay(id) {
  const { data } = await sb().from('moneyfusion_payments').select('*').eq('id', id).maybeSingle();
  return data || null;
}
async function findPay(ref, token) {
  if (ref) return await getPay(String(ref));
  if (token) { const { data } = await sb().from('moneyfusion_payments').select('*').eq('data->>token', String(token)).limit(1); return (data && data[0]) || null; }
  return null;
}

// Crédit/livraison après vérification MoneyFusion (RPC atomique + effets Node)
async function applyPaid(payId, verifiedAmountXof) {
  const pay = await getPay(payId);
  const verifiedEur = (verifiedAmountXof != null && verifiedAmountXof > 0) ? (verifiedAmountXof / L.EUR_XOF) : null;
  const r = await L.rpc('mf_apply_paid', { p_pay_id: payId, p_verified_xof: verifiedAmountXof != null ? verifiedAmountXof : null });
  if (!r || !r.done) return r || { done: false };
  if (r.already) return r;
  const target = r.target;
  if (r.kind === 'order' && r.orderId) {
    try { await L.grantOrderRewards(r.orderId); } catch (e) {}
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 2500);
      await fetch(L.BASE_URL + '/api/flashtopup-deliver', { method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json', 'X-Internal-Key': L.internalKey() }, body: JSON.stringify({ orderId: r.orderId }) }).catch(() => {});
      clearTimeout(t);
    } catch (e) {}
  }
  if (target) {
    if (r.kind === 'plus') await L.notify(target, '🪪', 'Badge activé', 'Votre badge « ' + (PLUS_NAMES[r.plusIdx] || 'vérifié') + ' » MgLoot Plus est actif (MoneyFusion). Il s\'affiche à côté de votre nom.', 'certificate', 'certificates');
    else if (r.kind === 'order') await L.notify(target, '✅', 'Paiement reçu', 'Votre commande est payée (MoneyFusion). Livraison en cours.', 'order', 'orders');
    else await L.notify(target, '💰', 'Portefeuille rechargé', 'Votre recharge de ' + (+r.credited || 0).toFixed(2) + ' € (MoneyFusion) a été créditée.', 'wallet', 'wallet');
  }
  return r;
}

async function markTimeoutAndNotify(payId) {
  const { data: upd } = await sb().from('moneyfusion_payments').update({ status: 'timeout', data: undefined }).eq('id', payId).eq('status', 'pending').select('id,user_id,data');
  if (!upd || !upd.length) return false;
  // réécrit timeoutAt dans data
  const row = upd[0];
  try { await sb().from('moneyfusion_payments').update({ data: Object.assign({}, row.data, { timeoutAt: new Date().toISOString() }) }).eq('id', payId); } catch (e) {}
  const d = row.data || {};
  const fcfa = (+d.xof || 0);
  const amtTxt = fcfa ? (fcfa.toLocaleString('fr-FR') + ' FCFA') : '';
  try { await L.notify(row.user_id, '⛔', 'Paiement échoué', 'Votre paiement' + (amtTxt ? ' de ' + amtTxt : '') + ' n\'a pas abouti. Aucun montant confirmé — vous pouvez réessayer.', 'payfail', 'payfail'); } catch (e) {}
  try {
    const to = d.email || '';
    if (to) {
      const E = require('./_email.js');
      const inner = '<h2 style="color:#ff6b6b;margin:0 0 10px">Paiement échoué</h2><p>Bonjour,</p>'
        + '<p>Votre paiement' + (amtTxt ? ' de <b>' + amtTxt + '</b>' : '') + ' sur MgLoot <b>n\'a pas abouti</b> dans le délai (13 minutes).</p>'
        + '<p>Aucun montant n\'a été confirmé. <b>Si un montant a été débité</b> de votre Mobile Money, il sera crédité automatiquement dès réception — sinon contactez le support.</p>'
        + '<p>Vous pouvez réessayer à tout moment depuis l\'application.</p><p>Merci,<br>L\'équipe MgLoot</p>';
      await E.sendEmail(to, 'MgLoot — Paiement échoué', E.wrap(inner));
    }
  } catch (e) {}
  return true;
}

async function reconcilePending() {
  const { data: rows } = await sb().from('moneyfusion_payments').select('*').eq('status', 'pending').limit(60);
  let verifies = 0, credited = 0, timedout = 0;
  for (const d of (rows || [])) {
    const token = d.data && d.data.token;
    if (!token) continue;
    const ms = d.created_at ? Date.parse(d.created_at) : 0;
    if (ms && (Date.now() - ms) > 2 * 3600 * 1000) continue;
    if (verifies >= 25) break;
    verifies++;
    try {
      const v = await mfVerify(token);
      if (v.ok && isPaidStatus(v.statut)) { const r = await applyPaid(d.id, v.amount); if (r && r.done) credited++; }
      else if (ms && (Date.now() - ms) > MF_TIMEOUT_MS) { if (await markTimeoutAndNotify(d.id)) timedout++; }
    } catch (e) {}
  }
  return { ok: true, verifies, credited, timedout };
}

module.exports = async (req, res) => {
  L.cors(res, 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // CRON
  if (req.method === 'GET' && req.query && req.query.cron === '1') {
    const secret = process.env.CRON_SECRET || '';
    const auth = String((req.headers && (req.headers.authorization || req.headers.Authorization)) || '');
    let ok = L.isInternal(req);
    if (!ok && secret) ok = (auth === 'Bearer ' + secret);
    if (!ok) { try { const u = await L.getAuthUser(req); ok = !!(u && u.isAdmin); } catch (e) {} }
    if (!ok && !secret) ok = true;
    if (!ok) return res.status(403).json({ error: 'Accès refusé' });
    try { return res.status(200).json(await reconcilePending()); }
    catch (e) { return res.status(200).json({ error: e.message }); }
  }

  // Outils admin (?diag / ?ip)
  if (req.method === 'GET' && req.query && (req.query.ip || req.query.diag)) {
    let allowed = L.adminToolOk(req);
    if (!allowed) { const u = await L.getAuthUser(req); allowed = !!(u && u.isAdmin); }
    if (!allowed) return res.status(403).json({ error: 'Accès refusé', astuce: 'admin.html → Commandes → « 💠 Revérifier MoneyFusion ».' });
    if (req.query.ip) { try { const r = await fetch('https://api.ipify.org?format=json'); const j = await r.json().catch(() => ({})); return res.status(200).json({ outboundIP: j.ip || '?' }); } catch (e) { return res.status(200).json({ error: e.message }); } }
    try {
      const recheck = req.query.recheck === '1';
      const { data: rows } = await sb().from('moneyfusion_payments').select('*').order('created_at', { ascending: false }).limit(10);
      const out = [];
      for (const d of (rows || [])) {
        let live = null, action = null;
        const token = d.data && d.data.token;
        if (token) {
          const v = await mfVerify(token);
          live = { statut: v.statut, montantPaye: v.amount, hote: v.via };
          if (recheck && d.status !== 'credited' && d.status !== 'paid' && v.ok && isPaidStatus(v.statut)) {
            const r2 = await applyPaid(d.id, v.amount);
            action = r2 && r2.done ? '✅ validé maintenant' : ('❌ ' + ((r2 && r2.problem) || 'non validé'));
          }
        }
        out.push({ ref: d.id, statusEnBase: d.status || '?', purpose: (d.data && d.data.purpose) || '?', commande: (d.data && d.data.orderId) || null, xofFacture: (d.data && d.data.xof) || 0, moneyFusionEnDirect: live, revalidation: action });
      }
      return res.status(200).json({ ok: true, baseUrl: L.BASE_URL, webhook: L.BASE_URL + '/api/moneyfusion', derniers: out });
    } catch (e) { return res.status(200).json({ error: e.message }); }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const p = L.body(req);

    // 1) CRÉER
    if (p.action === 'create') {
      const user = await L.getAuthUser(req);
      if (!user) return res.status(401).json({ error: 'Session invalide, reconnectez-vous.' });
      const uid = user.uid, email = user.email || '';
      const purpose = p.purpose === 'order' ? 'order' : (p.purpose === 'plus' ? 'plus' : 'wallet');
      const orderId = String(p.orderId || '');
      const phone = String(p.phone || '').trim().slice(0, 30);
      if (!phone) return res.status(400).json({ error: 'Numéro de téléphone requis pour MoneyFusion.' });

      let amountEur = 0, plusIdx = 0, plusDur = '';
      if (purpose === 'order') {
        if (!orderId) return res.status(400).json({ error: 'Commande introuvable.' });
        const { data: o } = await sb().from('orders').select('user_id,status,total').eq('id', orderId).maybeSingle();
        if (!o || o.user_id !== uid) return res.status(404).json({ error: 'Commande introuvable.' });
        if (o.status !== 'pending') return res.status(400).json({ error: 'Cette commande n\'est plus en attente de paiement.' });
        amountEur = Math.round((+o.total || 0) * 100) / 100;
      } else if (purpose === 'plus') {
        plusIdx = +p.plusIdx || 0; plusDur = String(p.plusDur || '');
        if (!plusIdx || !PLUS_DAYS[plusDur]) return res.status(400).json({ error: 'Badge invalide.' });
        const { data: cfg } = await sb().from('config').select('data').eq('id', 'shop').maybeSingle();
        const prices = (cfg && cfg.data && cfg.data.plusPrices) || {};
        const row = prices[String(plusIdx)] || {};
        amountEur = Math.round((+row[plusDur] || 0) * 100) / 100;
        if (!(amountEur > 0)) return res.status(400).json({ error: 'Prix du badge non configuré.' });
      } else {
        amountEur = Math.round((+p.amountEur || 0) * 100) / 100;
        if (amountEur > WALLET_MAX_EUR) return res.status(400).json({ error: 'Montant trop élevé.' });
      }
      if (!(amountEur >= 0.5)) return res.status(400).json({ error: 'Montant trop faible.' });
      const xof = Math.max(100, Math.round(amountEur * L.EUR_XOF));

      const ref = 'MF-' + uid.slice(0, 6) + '-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex');
      await sb().from('moneyfusion_payments').insert({
        id: ref, user_id: uid, status: 'pending',
        data: { email, amountEur, xof, purpose, orderId: orderId || null, plusIdx: plusIdx || null, plusDur: plusDur || null }
      });
      const payload = {
        totalPrice: xof,
        article: [{ nom: purpose === 'order' ? 'Commande MgLoot' : (purpose === 'plus' ? ('Badge MgLoot Plus — ' + (PLUS_NAMES[plusIdx] || '')) : 'Recharge Portefeuille MgLoot'), montant: xof }],
        numeroSend: phone, nomclient: String(p.name || email || 'Client MgLoot').slice(0, 80),
        personal_Info: [{ userId: uid, orderId: orderId || '', ref }],
        return_url: L.BASE_URL + '/success', webhook_url: L.BASE_URL + '/api/moneyfusion'
      };
      let data = {};
      for (let attempt = 1; attempt <= 2; attempt++) {
        const ctl = new AbortController(); const _t = setTimeout(() => ctl.abort(), 13000);
        try {
          const r = await fetch(MF_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify(payload), signal: ctl.signal });
          const raw = await r.text();
          try { data = JSON.parse(raw); } catch (e) { data = {}; }
          if (!data || typeof data !== 'object') data = {};
          break;
        } catch (err) {
          const timedOut = (err && err.name === 'AbortError');
          if (attempt === 2) return res.status(200).json({ error: timedOut ? 'MoneyFusion met trop de temps à répondre. Réessayez dans un instant.' : ('Connexion MoneyFusion impossible : ' + ((err && err.message) || err)) });
        } finally { clearTimeout(_t); }
      }
      if (data && (data.statut === true || data.statut === 'true' || data.statut === 1) && data.url) {
        const cur = await getPay(ref);
        await sb().from('moneyfusion_payments').update({ data: Object.assign({}, cur && cur.data, { token: data.token || '' }) }).eq('id', ref);
        return res.status(200).json({ ok: true, url: data.url, token: data.token || '', ref, amountEur });
      }
      return res.status(200).json({ error: (data && (data.message || data.msg)) || 'MoneyFusion a refusé la demande.' });
    }

    // 2) STATUS
    if (p.action === 'status') {
      const s = await findPay(String(p.ref || '').trim(), p.token);
      if (!s) return res.status(200).json({ ok: true, paid: false, note: 'paiement introuvable' });
      if (s.status === 'credited' || s.status === 'paid') return res.status(200).json({ ok: true, paid: true, status: s.status, purpose: (s.data && s.data.purpose) || 'wallet', orderId: (s.data && s.data.orderId) || null });
      const token = s.data && s.data.token;
      if (!token) return res.status(200).json({ ok: true, paid: false, note: 'token manquant' });
      const v = await mfVerify(token);
      if (v.ok && isPaidStatus(v.statut)) { const r2 = await applyPaid(s.id, v.amount); return res.status(200).json({ ok: true, paid: !!(r2 && r2.done), purpose: (s.data && s.data.purpose) || 'wallet', orderId: (s.data && s.data.orderId) || null, problem: r2 && r2.problem }); }
      return res.status(200).json({ ok: true, paid: false, status: String(v.statut || '').toLowerCase(), reachable: v.ok });
    }

    // 2bis) TIMEOUT
    if (p.action === 'timeout') {
      const user = await L.getAuthUser(req);
      const s = await findPay(String(p.ref || '').trim(), p.token);
      if (!s) return res.status(200).json({ ok: true, note: 'introuvable' });
      if (user && s.user_id && s.user_id !== user.uid) return res.status(403).json({ error: 'Accès refusé' });
      if (s.status === 'credited' || s.status === 'paid') return res.status(200).json({ ok: true, paid: true });
      const token = s.data && s.data.token;
      if (token) { const v = await mfVerify(token); if (v.ok && isPaidStatus(v.statut)) { const r2 = await applyPaid(s.id, v.amount); return res.status(200).json({ ok: true, paid: !!(r2 && r2.done) }); } }
      const failed = await markTimeoutAndNotify(s.id);
      return res.status(200).json({ ok: true, paid: false, failed });
    }

    // 3) WEBHOOK
    const d0 = (p.data && typeof p.data === 'object') ? p.data : p;
    const token = d0.tokenPay || d0.token || p.token || '';
    let ref = '';
    try { const pi = d0.personal_Info || p.personal_Info; if (Array.isArray(pi) && pi[0]) ref = pi[0].ref || ''; } catch (e) {}
    const s = await findPay(ref, token);
    if (!s) return res.status(200).json({ ok: true, ignored: 'ref/token introuvable' });
    const stok = s.data && s.data.token;
    if (!stok) return res.status(200).json({ ok: true, ignored: 'token absent' });
    if (token && token !== stok) return res.status(200).json({ ok: true, ignored: 'token différent' });
    const v = await mfVerify(stok);
    if (!(v.ok && isPaidStatus(v.statut))) return res.status(200).json({ ok: true, paid: false });
    await applyPaid(s.id, v.amount);
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[moneyfusion]', e);
    return res.status(500).json({ error: 'Erreur serveur : ' + String((e && e.message) || e).slice(0, 220) });
  }
};

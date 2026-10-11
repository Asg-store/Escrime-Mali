// ════════════════════════════════════════════════════════════════
//  MgLoot — module serveur partagé (Supabase)  —  remplace _lib.js
//
//  - Client Supabase (clé service_role → ignore la RLS, comme firebase-admin)
//  - Authentification : vérifie le jeton Supabase (Authorization: Bearer …)
//  - Clé INTERNE serveur → serveur (dérivée de SUPABASE_SERVICE_ROLE_KEY)
//  - Push FCM conservé (firebase-admin UNIQUEMENT pour la messagerie) ;
//    les jetons sont désormais lus dans la table Supabase `fcm_tokens`.
//  - Récompenses d'achat : RPC grant_order_rewards (idempotent)
//
//  Variables Vercel :
//    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (base + auth)
//    FIREBASE_SERVICE_ACCOUNT                  (UNIQUEMENT pour le push FCM)
//    PUBLIC_BASE_URL, ADMIN_TOOL_KEY (optionnelle)
// ════════════════════════════════════════════════════════════════
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const ADMIN_EMAIL = 'asgmali821@gmail.com';
const BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://mgloot.com').replace(/\/+$/, '').replace('://www.', '://');
const EUR_XOF = 655.957;

// ── Client Supabase (service_role) — une seule instance ──
let _supa = null;
function supa() {
  if (_supa) return _supa;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY manquants (variables Vercel)');
  _supa = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return _supa;
}

// ── Appel d'une fonction SQL (RPC). Convertit les erreurs « MGL:… » ──
class UserError extends Error {}
async function rpc(fn, args) {
  const { data, error } = await supa().rpc(fn, args || {});
  if (error) {
    const m = String(error.message || '');
    const i = m.indexOf('MGL:');
    if (i >= 0) throw new UserError(m.slice(i + 4).replace(/\s+$/,'').trim() || 'Opération refusée.');
    throw new Error(m || 'Erreur base de données.');
  }
  return data;
}

// ── Clé interne serveur → serveur (HMAC de la clé service_role) ──
function internalKey() {
  const k = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
  return crypto.createHmac('sha256', k).update('mgloot-internal-v1').digest('hex');
}
function isInternal(req) {
  const k = String((req.headers && (req.headers['x-internal-key'] || req.headers['X-Internal-Key'])) || '');
  if (!k) return false;
  try { const a = Buffer.from(k), b = Buffer.from(internalKey()); return a.length === b.length && crypto.timingSafeEqual(a, b); }
  catch (e) { return false; }
}
async function internalPost(path, body) {
  try {
    const r = await fetch(BASE_URL + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Key': internalKey() },
      body: JSON.stringify(body || {})
    });
    return await r.json().catch(() => ({}));
  } catch (e) { return { error: e.message }; }
}

function adminToolOk(req) {
  const want = process.env.ADMIN_TOOL_KEY || '';
  const got = String((req.query && req.query.key) || '');
  if (!want || !got) return false;
  const a = Buffer.from(got), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── Utilisateur à partir du jeton Supabase. null si absent/invalide. ──
async function getAuthUser(req) {
  const h = String((req.headers && (req.headers.authorization || req.headers.Authorization)) || '');
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  try {
    const { data, error } = await supa().auth.getUser(m[1]);
    if (error || !data || !data.user) return null;
    const u = data.user;
    const email = String(u.email || '').toLowerCase();
    const name = (u.user_metadata && (u.user_metadata.name || u.user_metadata.full_name || u.user_metadata.display_name)) || '';
    return { uid: u.id, email: u.email || '', name: name, isAdmin: email === ADMIN_EMAIL, token: u };
  } catch (e) { return null; }
}

function cors(res, methods) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', methods || 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Internal-Key');
}
function body(req) {
  let p = req.body;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { p = {}; } }
  return p || {};
}
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ════════════════════════════════════════════════════════════════
//  PUSH FCM — conservé. firebase-admin UNIQUEMENT pour la messagerie.
//  Les jetons viennent de la table Supabase `fcm_tokens`.
// ════════════════════════════════════════════════════════════════
const fbAdmin = require('firebase-admin');
function fcmApp() {
  if (fbAdmin.apps.length) return fbAdmin.app();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT manquant (requis pour le push FCM)');
  const cred = JSON.parse(raw);
  if (cred.private_key && cred.private_key.indexOf('\\n') >= 0) cred.private_key = cred.private_key.replace(/\\n/g, '\n');
  return fbAdmin.initializeApp({ credential: fbAdmin.credential.cert(cred) });
}

// Jetons uniques par (utilisateur + appareil) — préfère le domaine principal, le plus récent.
function uniqueTokenInfo(rows) {
  const best = new Map();
  (rows || []).forEach(v => {
    const t = v.token;
    if (!t) return;
    const ms = v.updated_at ? Date.parse(v.updated_at) || 0 : 0;
    const www = /^www\./i.test(String(v.host || ''));
    const key = v.user_id ? (v.user_id + '|' + String(v.platform || '')) : ('t|' + t);
    const cur = best.get(key);
    const better = !cur || (cur.www && !www) || (cur.www === www && ms > cur.ms);
    if (better) best.set(key, { t, ms, www, native: v.platform === 'android-app' });
  });
  const seen = new Set(); const out = [];
  best.forEach(v => { if (!seen.has(v.t)) { seen.add(v.t); out.push({ t: v.t, native: v.native }); } });
  return out;
}
function uniqueTokens(rows) { return uniqueTokenInfo(rows).map(x => x.t); }

function buildMessages(title, text, type, extra) {
  const open = BASE_URL + '/?open=' + encodeURIComponent(String(type || ''));
  const data = Object.assign({ title: String(title || 'MgLoot'), body: String(text || ''), url: open, type: String(type || ''), icon: BASE_URL + '/notif-logo.png' }, extra || {});
  Object.keys(data).forEach(k => { data[k] = String(data[k] == null ? '' : data[k]); });
  return {
    web: { data, webpush: { headers: { Urgency: 'high', TTL: '86400' } } },
    native: {
      data, android: { priority: 'high' },
      notification: data.image ? { title: data.title, body: data.body, imageUrl: data.image } : { title: data.title, body: data.body }
    }
  };
}
// Envoie à une liste [{t, native}] ; nettoie les jetons morts dans Supabase.
async function sendToTokens(list, title, text, type, extra) {
  if (!list.length) return { sent: 0 };
  fcmApp();
  const m = buildMessages(title, text, type, extra);
  let sent = 0; const stale = [];
  for (const group of [{ msg: m.web, toks: list.filter(x => !x.native).map(x => x.t) }, { msg: m.native, toks: list.filter(x => x.native).map(x => x.t) }]) {
    for (let i = 0; i < group.toks.length; i += 500) {
      const batch = group.toks.slice(i, i + 500);
      const r = await fbAdmin.messaging().sendEachForMulticast(Object.assign({}, group.msg, { tokens: batch }));
      sent += r.successCount;
      r.responses.forEach((x, k) => {
        const code = (x.error && x.error.code) || '';
        if (!x.success && (code.indexOf('registration-token-not-registered') >= 0 || code.indexOf('invalid-argument') >= 0)) stale.push(batch[k]);
      });
    }
  }
  if (stale.length) { try { await supa().from('fcm_tokens').delete().in('token', stale); } catch (e) {} }
  return { sent };
}
async function pushTo(uid, title, text, type, extra) {
  try {
    let q = supa().from('fcm_tokens').select('token,user_id,platform,host,updated_at');
    if (uid) q = q.eq('user_id', uid);
    const { data, error } = await q;
    if (error) return { sent: 0, error: error.message };
    return await sendToTokens(uniqueTokenInfo(data || []), title, text, type || 'announce', extra);
  } catch (e) { return { sent: 0, error: e.message }; }
}
// Notification in-app (table notifications) + push
async function notify(uid, icon, title, text, type, link, extra) {
  extra = extra || {};
  try {
    await supa().from('notifications').insert({
      user_id: uid, icon: icon || '🔔', title: title, body: text,
      type: type || '', link: link || type || '', read: false,
      data: extra
    });
  } catch (e) {}
  const pextra = {};
  if (extra.image) pextra.image = String(extra.image);
  await pushTo(uid, (icon ? icon + ' ' : '') + title, text, link || type, pextra);
}

// Admin uid (résolu par e-mail dans profiles, mis en cache)
let _adminUid = null;
async function adminUid() {
  if (_adminUid) return _adminUid;
  try {
    const { data } = await supa().from('profiles').select('id').eq('email', ADMIN_EMAIL).limit(1).maybeSingle();
    _adminUid = (data && data.id) || null;
  } catch (e) { _adminUid = null; }
  return _adminUid;
}
async function notifyAdmin(icon, title, text, type, link) {
  try { const uid = await adminUid(); if (uid) await notify(uid, icon, title, text, type || 'order', link || type || ''); } catch (e) {}
}

// ── Dates (identiques au client) ──
function todayKey(d) { d = d || new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
function weekKey(d) { d = d || new Date(); const on = new Date(d.getFullYear(), 0, 1); const wk = Math.ceil((((d - on) / 86400000) + on.getDay() + 1) / 7); return d.getFullYear() + '-W' + wk; }

const POINTS_PER_PURCHASE = 4;
const PAID_STATUSES = ['paid', 'delivered', 'processing', 'shipped'];

// ── Récompenses d'une commande payée (RPC idempotent) + alerte admin ──
async function grantOrderRewards(orderId) {
  const done = await rpc('grant_order_rewards', { p_order_id: orderId });
  if (done) {
    try {
      const { data: o } = await supa().from('orders').select('total,items,payment_method').eq('id', orderId).maybeSingle();
      if (o) {
        const amt = (+o.total || 0).toFixed(2);
        const first = (o.items && o.items[0] && (o.items[0].name || o.items[0].title)) || 'produit';
        const pm = o.payment_method || '';
        await notifyAdmin('🛒', 'Nouvelle commande payée', first + ' — ' + amt + ' €' + (pm ? ' (' + pm + ')' : '') + '. À traiter dans l\'admin.', 'order', 'orders');
      }
    } catch (e) {}
  }
  return done;
}

module.exports = {
  supa, rpc, UserError,
  ADMIN_EMAIL, BASE_URL, EUR_XOF,
  internalKey, isInternal, internalPost, adminToolOk, getAuthUser, cors, body, esc,
  pushTo, notify, notifyAdmin, adminUid, uniqueTokens, uniqueTokenInfo, sendToTokens,
  todayKey, weekKey, POINTS_PER_PURCHASE, PAID_STATUSES, grantOrderRewards
};

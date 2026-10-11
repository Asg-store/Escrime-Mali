// ════════════════════════════════════════════════════════════════
//  MgLoot — /api/shop   (TOUTES les opérations d'argent et de points)
//  Version Supabase : le client DEMANDE, le serveur (service_role) relit
//  les vrais prix (products/config/promos) et exécute les débits via des
//  fonctions SQL atomiques (RPC). Même comportement qu'avant (Firestore).
//
//  POST JSON { action, ... }   Header : Authorization: Bearer <jeton Supabase>
// ════════════════════════════════════════════════════════════════
const crypto = require('crypto');
const L = require('./_supabase.js');

const ARENA_PACKS_DEFAULT = [{ pts: 20, cost: 1 }, { pts: 50, cost: 2 }, { pts: 150, cost: 5 }, { pts: 350, cost: 10 }];
const REVIEW_POINTS = { 1: 5, 2: 10, 3: 15, 4: 20, 5: 25 };
const WHEEL_PRIZES = [2, 5, 0, 10, 20, 5, 15, 40];
const POINT_VALUE_EUR = 0.01;
function pointsTierMax(amountEur) { const a = +amountEur || 0; if (a <= 0) return 0; const maxDisc = Math.min(a * 0.10, 2); return Math.round(maxDisc / POINT_VALUE_EUR); }

const UserError = L.UserError;
const fail = (m) => { throw new UserError(m); };
const r2 = (n) => Math.round((+n || 0) * 100) / 100;
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 200);
const newId = () => crypto.randomBytes(12).toString('hex');
const sb = () => L.supa();

async function getConfig() {
  try { const { data } = await sb().from('config').select('data').eq('id', 'shop').maybeSingle(); return (data && data.data) || {}; }
  catch (e) { return {}; }
}
function normUser(row) {
  if (!row) return {};
  const d = row.data || {}, s = row.server_data || {};
  return Object.assign({}, d, s, {
    points: +row.points || 0,
    walletBalance: +row.wallet_balance || 0,
    totalSpent: +row.total_spent || 0,
    orderCount: +row.order_count || 0,
    loyaltyXP: +row.loyalty_xp || 0,
    accountStatus: row.account_status || 'active',
    suspendUntil: row.suspend_until ? (Date.parse(row.suspend_until) || 0) : 0,
    name: d.name || row.display_name || '',
    email: row.email || ''
  });
}
async function loadUser(uid) {
  const { data } = await sb().from('profiles').select('*').eq('id', uid).maybeSingle();
  return normUser(data);
}
async function getProduct(id) {
  const { data } = await sb().from('products').select('data').eq('id', id).maybeSingle();
  return data ? (data.data || {}) : null;
}

function deliveryFee(cfg, sub) {
  const t = cfg.deliveryFeeType || 'none', v = +cfg.deliveryFeeValue || 0;
  if (t === 'percent') return r2(sub * v / 100);
  if (t === 'fixed') return v;
  return 0;
}
function levels(cfg) {
  const VIP_NAMES = ['Bronze', 'Argent', 'Or', 'Diamant', 'Émeraude', 'Saphir', 'Rubis', 'Améthyste', 'Platine', 'Élite', 'Max'];
  const c = cfg.loyaltyLevels || {};
  const t = cfg.vipTiers;
  if (Array.isArray(t) && t.length) {
    return t.map((x, i) => ({ name: x.name || VIP_NAMES[i] || ('VIP' + (i + 1)), min: i === 0 ? 0 : (+x.min || 0), discount: +x.discount || 0, qty: +x.qty || 0 }));
  }
  return [
    { name: 'Bronze', min: 0, discount: +c.bronzeDisc || 0, qty: +c.bronzeQty || 0 },
    { name: 'Argent', min: c.silverMin != null ? +c.silverMin : 500, discount: +c.silverDisc || 0, qty: +c.silverQty || 0 },
    { name: 'Or', min: c.goldMin != null ? +c.goldMin : 2000, discount: +c.goldDisc || 0, qty: +c.goldQty || 0 },
    { name: 'Diamant', min: c.diamondMin != null ? +c.diamondMin : 5000, discount: +c.diamondDisc || 0, qty: +c.diamondQty || 0 }
  ];
}
function vipIdx(cfg, u) {
  const Lv = levels(cfg); const exp = (+u.totalSpent || 0) * (+cfg.vipExpPerEur || 100);
  let idx = 0; for (let i = 0; i < Lv.length; i++) if (exp >= Lv[i].min) idx = i;
  return { idx, L: Lv };
}
function vipResetKey(cfg) {
  const mode = cfg.loyaltyReset || 'never'; const d = new Date();
  if (mode === 'monthly') return d.getFullYear() + '-' + (d.getMonth() + 1);
  if (mode === 'quarterly') return d.getFullYear() + '-Q' + (Math.floor(d.getMonth() / 3) + 1);
  if (mode === 'yearly') return '' + d.getFullYear();
  return 'all';
}
const pbKey = (name) => String(name || '').toLowerCase().trim().replace(/[.#$/\[\]~*]/g, '_');

function buyerInfo(user) {
  return { userId: user.uid, userName: user.name || (user.email || '').split('@')[0], email: user.email || '' };
}
function cleanAccount(a) {
  if (!a || typeof a !== 'object') return null;
  const out = {}; let n = 0;
  Object.keys(a).forEach(k => { if (n < 12 && /^[\w-]{1,40}$/.test(k)) { const v = a[k]; if (v == null || typeof v !== 'object') { out[k] = str(v, 200); n++; } } });
  return n ? out : null;
}

// ────────────────── Calcul du panier (source de vérité) ──────────────────
async function priceCart(cfg, user, u, p) {
  const raw = Array.isArray(p.items) ? p.items : [];
  if (!raw.length) fail('Panier vide.');
  if (raw.length > 30) fail('Panier trop grand.');
  const qtyById = {};
  raw.forEach(it => {
    const id = str(it && it.id, 120); const q = Math.floor(+(it && it.qty) || 0);
    if (!id || q < 1 || q > 50) fail('Article invalide.');
    qtyById[id] = (qtyById[id] || 0) + q;
  });
  const ids = Object.keys(qtyById);
  const { data: rows } = await sb().from('products').select('id,data').in('id', ids);
  const byId = {}; (rows || []).forEach(r => { byId[r.id] = r.data || {}; });
  const items = []; let sub = 0; const games = [];
  ids.forEach(id => {
    const pr = byId[id];
    if (!pr) fail('Un produit du panier n\'existe plus. Videz le panier et réessayez.');
    if (pr.active === false) fail('« ' + (pr.name || 'Produit') + ' » n\'est plus disponible.');
    const price = +pr.price || 0;
    if (!(price > 0)) fail('Prix invalide pour « ' + (pr.name || 'Produit') + ' ».');
    const qty = qtyById[id];
    const it = { id: id, name: pr.name || 'Produit', price, qty };
    if (pr.fzrCat) it.fzrCat = pr.fzrCat; if (pr.fzrOffer) it.fzrOffer = pr.fzrOffer;
    items.push(it);
    sub += price * qty;
    games.push(String(pr.game || pr.category || '').trim().toLowerCase());
  });
  sub = r2(sub);
  const ptsLimit = Math.min(pointsTierMax(sub), Math.floor(sub / POINT_VALUE_EUR));
  const fee = deliveryFee(cfg, sub);

  let disc = 0, promoCode = '';
  const code = str(p.promoCode, 40).toUpperCase();
  if (code) {
    if ((u.usedPromos || []).indexOf(code) >= 0) fail('Vous avez déjà utilisé ce code promo (une seule fois par client).');
    const { data: pq } = await sb().from('promos').select('data').eq('code', code).limit(1);
    const pm = (pq && pq[0] && pq[0].data) || null;
    if (!pm) fail('Code promo invalide.');
    const now = Date.now();
    const ts = (v) => (v ? (typeof v === 'number' ? v : Date.parse(v) || 0) : 0);
    if (pm.active === false) fail('Code promo désactivé.');
    if (pm.expiresAt && ts(pm.expiresAt) && ts(pm.expiresAt) < now) fail('Code promo expiré.');
    if (pm.validFrom && ts(pm.validFrom) > now) fail('Ce code promo n\'est pas encore actif.');
    if (pm.minAmount && sub < +pm.minAmount) fail('Montant minimum non atteint pour ce code.');
    if (pm.gameScope && games.indexOf(String(pm.gameScope).trim().toLowerCase()) < 0) fail('Ce code est valable uniquement pour ' + pm.gameScope + '.');
    disc = pm.type === 'percent' ? sub * (+pm.value || 0) / 100 : (+pm.value || 0);
    disc = r2(Math.max(0, Math.min(disc, sub)));
    promoCode = code;
  }

  let vipPct = 0, vipCouponId = '';
  const cid = str(p.vipCouponId, 60);
  if (cid) {
    const c = (u.vipCoupons || []).find(x => x && x.id === cid && !x.used);
    if (!c) fail('Coupon VIP invalide ou déjà utilisé.');
    vipPct = Math.max(0, Math.min(100, +c.pct || 0)); vipCouponId = cid;
  }
  const lvlDisc = vipPct > 0 ? Math.round((sub - disc) * vipPct) / 100 : 0;

  let pointsUsed = 0, ptsDisc = 0;
  if (p.usePoints) {
    pointsUsed = Math.max(0, Math.min(ptsLimit, Math.floor(+u.points || 0)));
    ptsDisc = Math.round(pointsUsed * POINT_VALUE_EUR * 10000) / 10000;
  }
  const total = r2(Math.max(0, sub + fee - disc - lvlDisc - ptsDisc));
  return { items, subtotal: sub, deliveryFee: fee, discount: r2(disc + lvlDisc + ptsDisc), promoCode, vipCouponId, vipPct, pointsUsed, total };
}

// ────────────────── Actions ──────────────────
const A = {};

A.checkout = async (user, p) => {
  const method = str(p.method, 20);
  if (['wallet', 'moneyfusion', 'orange', 'wave'].indexOf(method) < 0) fail('Moyen de paiement non disponible.');
  const playerId = str(p.playerId, 80);
  const cfg = await getConfig();
  const u = await loadUser(user.uid);
  const pc = await priceCart(cfg, user, u, p);
  if (p.expectedTotal != null && Math.abs((+p.expectedTotal || 0) - pc.total) > 0.011) {
    fail('Le prix de votre panier a changé (nouveau total : ' + Math.round(pc.total * L.EUR_XOF).toLocaleString('fr-FR') + ' FCFA). Rouvrez le panier et réessayez.');
  }
  const orderId = newId();
  const orderData = Object.assign({
    subtotal: pc.subtotal, deliveryFee: pc.deliveryFee, discount: pc.discount,
    vipCouponId: pc.vipCouponId || '', vipPct: pc.vipPct || 0,
    playerId, playerName: str(p.playerName, 80), serverId: str(p.serverId, 40), account: cleanAccount(p.account),
    createdAt: new Date().toISOString()
  }, buyerInfo(user));

  if (method === 'wallet') {
    await L.rpc('checkout_wallet', {
      p_uid: user.uid, p_order_id: orderId, p_total: pc.total,
      p_items: pc.items, p_data: orderData, p_promo_code: pc.promoCode || '',
      p_points_used: pc.pointsUsed, p_vip_coupon_id: pc.vipCouponId || ''
    });
    try { await L.grantOrderRewards(orderId); } catch (e) {}
    return { ok: true, orderId, total: pc.total, status: 'paid', paymentMethod: 'wallet' };
  }

  let pm = 'MoneyFusion';
  if (method === 'moneyfusion') {
    if (pc.total < 0.5) fail('Montant trop faible pour MoneyFusion.');
  } else {
    const proofUrl = String(p.proofUrl || '');
    if (!/^https:\/\//i.test(proofUrl) && !/^data:image\//i.test(proofUrl)) fail('Ajoutez la capture d\'écran du reçu.');
    if (proofUrl.length > 720000) fail('Preuve trop lourde.');
    pm = method === 'wave' ? 'Wave (manuel)' : 'Orange Money (manuel)';
    orderData.proofUrl = proofUrl;
    orderData.payerPhone = str(p.payerPhone, 30); orderData.txRef = str(p.txRef, 60);
    orderData.amountFcfa = Math.round(pc.total * L.EUR_XOF);
  }
  await L.rpc('checkout_pending', {
    p_uid: user.uid, p_order_id: orderId, p_total: pc.total, p_payment_method: pm,
    p_items: pc.items, p_data: orderData, p_points_used: pc.pointsUsed, p_vip_coupon_id: pc.vipCouponId || ''
  });
  return { ok: true, orderId, total: pc.total, status: 'pending', paymentMethod: pm };
};

A.buyWithPoints = async (user, p) => {
  const id = str(p.productId, 120); const playerId = str(p.playerId, 80);
  if (!id) fail('Produit introuvable.'); if (!playerId) fail('ID joueur requis.');
  const pr = await getProduct(id);
  if (!pr) fail('Produit introuvable.');
  const cost = Math.floor(+pr.pointsCost || 0);
  if (!pr.pointsBuyable || cost <= 0) fail('Ce produit n\'est pas disponible en points.');
  const it = { id, name: pr.name || 'Produit', price: 0, qty: 1 };
  if (pr.fzrCat) it.fzrCat = pr.fzrCat; if (pr.fzrOffer) it.fzrOffer = pr.fzrOffer;
  const orderId = newId();
  await L.rpc('buy_with_points', {
    p_uid: user.uid, p_order_id: orderId, p_cost: cost, p_items: [it],
    p_data: Object.assign({ playerId, createdAt: new Date().toISOString() }, buyerInfo(user))
  });
  return { ok: true, orderId, cost };
};

A.buyPointsProduct = async (user, p) => {
  const id = str(p.id, 120);
  const { data: row } = await sb().from('points_products').select('data').eq('id', id).maybeSingle();
  const pp = row ? (row.data || {}) : null;
  if (!id || !pp) fail('Produit introuvable.');
  if (pp.active === false) fail('Produit indisponible.');
  const cost = Math.floor(+pp.pointsCost || 0); if (cost <= 0) fail('Produit indisponible.');
  const playerId = str(p.playerId, 80);
  if (pp.needPlayerId !== false && !playerId) fail('Entrez votre ID joueur pour la livraison.');
  const catId = pp.catalogProductId || id;
  let fzrCat = pp.fzrCat || '', fzrOffer = pp.fzrOffer || '';
  if ((!fzrCat || !fzrOffer) && pp.catalogProductId) {
    const cd = await getProduct(pp.catalogProductId) || {};
    fzrCat = fzrCat || cd.fzrCat || ''; fzrOffer = fzrOffer || cd.fzrOffer || '';
  }
  const it = { id: catId, name: pp.name || 'Produit', price: 0, qty: 1, ftServiceCode: pp.ftServiceCode || '' };
  if (fzrCat) it.fzrCat = fzrCat; if (fzrOffer) it.fzrOffer = fzrOffer;
  const orderId = newId();
  await L.rpc('buy_with_points', {
    p_uid: user.uid, p_order_id: orderId, p_cost: cost, p_items: [it],
    p_data: Object.assign({ playerId, createdAt: new Date().toISOString() }, buyerInfo(user))
  });
  return { ok: true, orderId, cost };
};

A.buyPointsPack = async (user, p) => {
  const cfg = await getConfig();
  const packs = (Array.isArray(cfg.arenaPacks) && cfg.arenaPacks.length) ? cfg.arenaPacks : ARENA_PACKS_DEFAULT;
  const pk = packs[Math.floor(+p.index)];
  if (!pk || !(+pk.cost > 0) || !(+pk.pts > 0)) fail('Pack introuvable.');
  const cost = +pk.cost, pts = Math.floor(+pk.pts);
  await L.rpc('buy_points_pack', { p_uid: user.uid, p_cost: cost, p_pts: pts });
  return { ok: true, pts, cost };
};

async function readCredentials(accountId) {
  const { data } = await sb().from('account_private').select('data').eq('account_id', accountId).maybeSingle();
  if (!data || !data.data) return null;
  const c = data.data.credentials || data.data;
  return { login: c.login || '', password: c.password || '', notes: c.notes || '' };
}
async function deliverCredentials(user, buyId, acc, cred) {
  const { data: cur } = await sb().from('account_purchases').select('data').eq('id', buyId).maybeSingle();
  const merged = Object.assign({}, cur && cur.data, { status: 'delivered', deliveredAt: new Date().toISOString(), credentials: cred });
  await sb().from('account_purchases').update({ data: merged }).eq('id', buyId);
  const title = (acc && acc.title) || 'Votre compte';
  try {
    if (user.email) {
      const M = require('./_email.js');
      await M.sendEmail(user.email, '🎁 Identifiants de votre compte — MgLoot', M.wrap(
        '<h2 style="color:#e8c766;margin:0 0 10px">🎁 Votre compte est prêt</h2>'
        + '<p>Voici les identifiants de votre achat : <b>' + L.esc(title) + '</b></p>'
        + '<div style="background:#141418;border-radius:10px;padding:14px;margin:12px 0;font-size:15px">'
        + '<b>Identifiant :</b> ' + L.esc(cred.login || '—') + '<br><b>Mot de passe :</b> ' + L.esc(cred.password || '—')
        + (cred.notes ? ('<br><br><b>Notes :</b><br>' + L.esc(cred.notes).replace(/\n/g, '<br>')) : '')
        + '</div><p style="color:#ff9">⚠️ Changez le mot de passe dès votre première connexion.</p>'));
    }
  } catch (e) {}
  await L.notify(user.uid, '🎁', 'Compte livré', 'Les identifiants de « ' + title + ' » sont disponibles.', 'account', 'account');
}
A.buyAccount = async (user, p) => {
  const id = str(p.accountId, 120); const method = p.method === 'points' ? 'points' : 'wallet';
  const res = await L.rpc('buy_account', {
    p_uid: user.uid, p_account_id: id, p_method: method,
    p_user_name: user.name || (user.email || '').split('@')[0], p_user_email: user.email || ''
  });
  const buyId = res.buyId;
  const { data: accRow } = await sb().from('accounts').select('data').eq('id', id).maybeSingle();
  const acc = accRow ? (accRow.data || {}) : {};
  const cred = await readCredentials(id);
  if (cred) await deliverCredentials(user, buyId, acc, cred);
  return { ok: true, credentials: cred, price: res.price, pointsCost: res.pointsCost, method };
};
A.accountCredentials = async (user, p) => {
  const id = str(p.accountId, 120);
  const buyId = user.uid + '_' + id;
  const { data: b } = await sb().from('account_purchases').select('data').eq('id', buyId).maybeSingle();
  const bd = b ? (b.data || {}) : null;
  if (!id || !bd) fail('Aucun achat trouvé pour ce compte.');
  if (bd.status !== 'paid' && bd.status !== 'delivered') fail('Paiement non confirmé.');
  if (bd.credentials && bd.credentials.login) return Object.assign({ ok: true }, bd.credentials);
  const cred = await readCredentials(id);
  if (!cred) fail('Identifiants pas encore renseignés. Le support vous les envoie sous peu.');
  const { data: accRow } = await sb().from('accounts').select('data').eq('id', id).maybeSingle();
  await deliverCredentials(user, buyId, accRow ? (accRow.data || {}) : {}, cred);
  return Object.assign({ ok: true }, cred);
};

A.buyVpn = async (user, p) => {
  const id = str(p.vpnId, 120); const method = p.method === 'points' ? 'points' : 'wallet';
  const res = await L.rpc('buy_vpn', {
    p_uid: user.uid, p_file_id: id, p_method: method,
    p_user_name: user.name || (user.email || '').split('@')[0]
  });
  let fileText = '';
  try {
    const { data: sec } = await sb().from('vpn_secret').select('data').eq('file_id', id).maybeSingle();
    fileText = (sec && sec.data && (sec.data.text || sec.data.content)) || '';
  } catch (e) {}
  if (fileText) {
    const { data: cur } = await sb().from('vpn_purchases').select('data').eq('id', user.uid + '_' + id).maybeSingle();
    await sb().from('vpn_purchases').update({ data: Object.assign({}, cur && cur.data, { fileText }) }).eq('id', user.uid + '_' + id);
  }
  return { ok: true, fileText, name: res.name || 'VPN', fileName: res.fileName };
};

A.boost = async (user, p) => {
  const id = str(p.accountId, 120); const method = p.method === 'points' ? 'points' : 'wallet';
  const cfg = await getConfig();
  const euro = +cfg.adPrice || 0, pts = Math.floor(+cfg.adPricePoints || 0), days = +cfg.adDays || 7;
  await L.rpc('boost_account', { p_uid: user.uid, p_account_id: id, p_method: method, p_euro: euro, p_pts: pts, p_days: days });
  return { ok: true, days };
};

// ── Missions mensuelles ──
const MONTHLY_SETS = [
  [ { k: 'buy1', type: 'orders', goal: 1, reward: 15 }, { k: 'review', type: 'review', goal: 1, reward: 5 }, { k: 'wheel', type: 'wheel', goal: 1, reward: 5 }, { k: 'invite2', type: 'invite', goal: 2, reward: 15 }, { k: 'share', type: 'share', goal: 1, reward: 10 } ],
  [ { k: 'buy3', type: 'orders', goal: 3, reward: 20 }, { k: 'spend10', type: 'spend', goal: 10, reward: 20 }, { k: 'wheel', type: 'wheel', goal: 1, reward: 5 }, { k: 'review', type: 'review', goal: 1, reward: 5 }, { k: 'notif', type: 'notif', goal: 1, reward: 5 } ],
  [ { k: 'buy2', type: 'orders', goal: 2, reward: 15 }, { k: 'invite3', type: 'invite', goal: 3, reward: 20 }, { k: 'wheel', type: 'wheel', goal: 1, reward: 5 }, { k: 'share', type: 'share', goal: 1, reward: 10 }, { k: 'profile', type: 'profile', goal: 1, reward: 5 } ],
  [ { k: 'buy5', type: 'orders', goal: 5, reward: 30 }, { k: 'spend20', type: 'spend', goal: 20, reward: 25 }, { k: 'review', type: 'review', goal: 1, reward: 5 }, { k: 'wheel', type: 'wheel', goal: 1, reward: 5 }, { k: 'invite2', type: 'invite', goal: 2, reward: 15 } ],
  [ { k: 'buy1', type: 'orders', goal: 1, reward: 15 }, { k: 'share', type: 'share', goal: 1, reward: 10 }, { k: 'wheel', type: 'wheel', goal: 1, reward: 5 }, { k: 'invite1', type: 'invite', goal: 1, reward: 10 }, { k: 'review', type: 'review', goal: 1, reward: 5 } ],
  [ { k: 'buy3', type: 'orders', goal: 3, reward: 20 }, { k: 'spend15', type: 'spend', goal: 15, reward: 25 }, { k: 'wheel', type: 'wheel', goal: 1, reward: 5 }, { k: 'notif', type: 'notif', goal: 1, reward: 5 }, { k: 'invite2', type: 'invite', goal: 2, reward: 15 } ]
];
function _monthKey(dt) { dt = dt || new Date(); return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0'); }
function monthlyMissions() {
  const now = new Date();
  const mk = _monthKey(now);
  const idx = (now.getFullYear() * 12 + now.getMonth()) % MONTHLY_SETS.length;
  return MONTHLY_SETS[idx].map(m => Object.assign({}, m, { id: 'mm:' + mk + ':' + m.k }));
}
function rawCounter(m, u) {
  switch (m.type) {
    case 'spend': return +u.totalSpent || 0;
    case 'firstBuy': case 'orders': return +u.orderCount || 0;
    case 'invite': return +u.referralCount || 0;
    case 'product': return +((u.productBuys || {})[pbKey(m.productName)] || 0);
    default: return null;
  }
}
async function missionProgress(m, u, uid) {
  const base = (u.missionBaselines && u.missionBaselines[m.id] != null) ? (+u.missionBaselines[m.id] || 0) : 0;
  const seen = (u.missionSeenAt && +u.missionSeenAt[m.id]) || 0;
  const fresh = (actionAt, ok) => (!seen ? (ok ? 1 : 0) : ((ok && actionAt && +actionAt >= seen) ? 1 : 0));
  switch (m.type) {
    case 'buyWeek': return u.weekKey === L.weekKey() ? (+u.weekBuys || 0) : 0;
    case 'spend': return Math.max(0, (+u.totalSpent || 0) - base);
    case 'firstBuy': case 'orders': return Math.max(0, (+u.orderCount || 0) - base);
    case 'review': return fresh(u.reviewAt, u.reviewBonusGiven);
    case 'invite': return Math.max(0, (+u.referralCount || 0) - base);
    case 'wheel': return u.lastWheelDay === L.todayKey() ? 1 : 0;
    case 'product': return Math.max(0, rawCounter(m, u) - base);
    case 'profile': return fresh(u.profileAt, !!(u.name && u.phone));
    case 'notif': { const { data } = await sb().from('fcm_tokens').select('token').eq('user_id', uid).limit(1); return (data && data.length) ? 1 : 0; }
    case 'install': return 1;
    case 'share': return fresh(u.shareAt, u.sharedShop);
    default: return 0;
  }
}
A.claimMission = async (user, p) => {
  const mid = str(p.missionId, 120);
  const m = monthlyMissions().find(x => x.id === mid);
  if (!m) fail('Mission introuvable.');
  const reward = Math.floor(+m.reward || 0);
  if (reward <= 0) fail('Cette mission n\'a pas de récompense.');
  const u = await loadUser(user.uid);
  if ((await missionProgress(m, u, user.uid)) < (+m.goal || 1)) fail('Mission non terminée.');
  const got = await L.rpc('claim_mission', { p_uid: user.uid, p_mission_id: m.id, p_reward: reward });
  if (!got) return { ok: true, already: true, reward: 0 };
  return { ok: true, reward: got };
};

A.spinWheel = async (user) => {
  const day = L.todayKey();
  const idx = crypto.randomInt(0, WHEEL_PRIZES.length);
  const prize = WHEEL_PRIZES[idx];
  await L.rpc('spin_wheel', { p_uid: user.uid, p_day: day, p_prize: prize });
  return { ok: true, idx, prize, day };
};

A.review = async (user, p) => {
  const stars = Math.floor(+p.rating || 0);
  if (stars < 1 || stars > 5) fail('Choisissez une note.');
  const comment = str(p.comment, 500);
  const photo = String(p.photo || '');
  if (photo && (photo.length > 850000 || !/^(data:image\/|https:\/\/)/i.test(photo))) fail('Photo invalide ou trop lourde.');
  const award = REVIEW_POINTS[stars] || 0;
  const awarded = await L.rpc('add_review', {
    p_uid: user.uid, p_review_id: newId(), p_rating: stars, p_comment: comment, p_photo: photo,
    p_user_name: user.name || (user.email || '').split('@')[0], p_user_email: user.email || '', p_award: award
  });
  return { ok: true, awarded: awarded || 0 };
};

A.claimVipCoupon = async (user, p) => {
  const li = Math.floor(+p.level);
  const cfg = await getConfig();
  const u = await loadUser(user.uid);
  const v = vipIdx(cfg, u);
  if (!(li >= 0) || li > v.idx) fail('Niveau VIP non atteint.');
  const lv = v.L[li]; const qty = +lv.qty || 0, pct = +lv.discount || 0;
  if (qty <= 0 || pct <= 0) fail('Aucun coupon à ce niveau.');
  const key = vipResetKey(cfg); const meta = u.vipCouponMeta || {};
  const claimed = (meta.period === key && meta.claimed && typeof meta.claimed === 'object') ? Object.assign({}, meta.claimed) : {};
  const got = +(claimed[li] || 0);
  if (got >= qty) fail('Coupon déjà réclamé pour ce niveau ce cycle.');
  claimed[li] = got + 1;
  const coupon = { id: 'C' + Date.now() + crypto.randomInt(0, 1000), pct, used: false, lvl: lv.name };
  await L.rpc('claim_vip_coupon', { p_uid: user.uid, p_coupon: coupon, p_meta: { period: key, claimed } });
  return { ok: true, coupon };
};

A.sync = async (user) => {
  const out = { ok: true, rewarded: 0 };
  try {
    const { data: os } = await sb().from('orders').select('id,status,rewarded,payment_method').eq('user_id', user.uid);
    for (const o of (os || [])) {
      if (o.rewarded === true || L.PAID_STATUSES.indexOf(o.status) < 0) continue;
      if (o.payment_method === 'points') { await sb().from('orders').update({ rewarded: true }).eq('id', o.id); continue; }
      if (await L.grantOrderRewards(o.id)) out.rewarded++;
    }
  } catch (e) { out.rewardsError = e.message; }

  try {
    const { data: row } = await sb().from('profiles').select('server_data').eq('id', user.uid).maybeSingle();
    const u = normUser({ server_data: (row && row.server_data) || {} });
    const mk = _monthKey(); const mmCur = 'mm:' + mk + ':';
    const keepId = (id) => (String(id).indexOf('mm:') !== 0 || String(id).indexOf(mmCur) === 0);
    const baselines = {}, seenAt = {};
    Object.keys(u.missionBaselines || {}).forEach(k => { if (keepId(k)) baselines[k] = u.missionBaselines[k]; });
    Object.keys(u.missionSeenAt || {}).forEach(k => { if (keepId(k)) seenAt[k] = u.missionSeenAt[k]; });
    const claimed = Array.isArray(u.claimedMissions) ? u.claimedMissions : [];
    const claimedKept = claimed.filter(keepId);
    let changed = (Object.keys(baselines).length !== Object.keys(u.missionBaselines || {}).length)
      || (Object.keys(seenAt).length !== Object.keys(u.missionSeenAt || {}).length);
    monthlyMissions().forEach(m => {
      if (claimedKept.indexOf(m.id) >= 0) return;
      if (seenAt[m.id] == null) { seenAt[m.id] = Date.now(); changed = true; }
      const raw = rawCounter(m, u);
      if (raw === null || baselines[m.id] != null) return;
      baselines[m.id] = raw; changed = true;
    });
    if (changed || claimedKept.length !== claimed.length) {
      const patch = { missionBaselines: baselines, missionSeenAt: seenAt };
      if (claimedKept.length !== claimed.length) patch.claimedMissions = claimedKept;
      const { data: cur } = await sb().from('profiles').select('server_data').eq('id', user.uid).maybeSingle();
      await sb().from('profiles').update({ server_data: Object.assign({}, cur && cur.server_data, patch) }).eq('id', user.uid);
    }
  } catch (e) {}
  return out;
};

// ────────────────── Routeur ──────────────────
module.exports = async (req, res) => {
  L.cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const p = L.body(req);
  const fn = A[String(p.action || '')];
  if (!fn) return res.status(400).json({ error: 'Action inconnue.' });
  try {
    const user = await L.getAuthUser(req);
    if (!user) return res.status(401).json({ error: 'Session expirée, reconnectez-vous.' });
    if (p.action !== 'sync') {
      const { data: ud } = await sb().from('profiles').select('account_status,suspend_until').eq('id', user.uid).maybeSingle();
      const st = (ud && ud.account_status) || 'active';
      const until = ud && ud.suspend_until ? (Date.parse(ud.suspend_until) || 0) : 0;
      if (st === 'blocked' || st === 'deleted' || (st === 'suspended' && (!until || until > Date.now()))) {
        return res.status(403).json({ error: 'Votre compte est suspendu. Contactez le support.' });
      }
    }
    const out = await fn(user, p);
    return res.status(200).json(out);
  } catch (e) {
    if (e instanceof UserError) return res.status(400).json({ error: e.message });
    console.error('[shop]', p.action, e);
    return res.status(500).json({ error: 'Erreur serveur : ' + String((e && e.message) || e).slice(0, 220) });
  }
};

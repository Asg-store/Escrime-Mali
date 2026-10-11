// ════════════════════════════════════════════════════════════════
//  MgLoot — /api/send-push  — version Supabase (push FCM + e-mail + IA)
//  FCM conservé ; les jetons viennent de la table Supabase fcm_tokens.
// ════════════════════════════════════════════════════════════════
const L = require('./_supabase.js');
const dns = require('dns').promises;
const net = require('net');

function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const s = ip.toLowerCase();
  return s === '::1' || s === '::' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80') || s.startsWith('::ffff:');
}
async function safeImageUrl(u) {
  let url; try { url = new URL(String(u)); } catch (e) { return null; }
  if (url.protocol !== 'https:') return null;
  try { const addrs = await dns.lookup(url.hostname, { all: true }); if (!addrs.length || addrs.some(a => privateIp(a.address))) return null; }
  catch (e) { return null; }
  return url.toString();
}

async function geminiReply(b) {
  const KEY = process.env.GEMINI_API_KEY;
  if (!KEY) return { reply: '', err: 'GEMINI_API_KEY absente sur Vercel' };
  const ctx = String(b.context || '').slice(0, 5000);
  const sys = "Tu es l'assistant virtuel de MgLoot, une application de recharges de jeux et marketplace. "
    + "MgLoot propose : recharges (UC PUBG Mobile, diamants Free Fire, CP Call of Duty, etc.), vente de comptes de jeu entre particuliers (Marketplace), une Boutique VPN, des points de fidélité, un portefeuille MgLoot, et un système de parrainage. "
    + "Moyens de paiement : Orange Money, Wave, MoneyFusion et le portefeuille MgLoot. Après paiement validé, la livraison est automatique et rapide (UC/diamants livrés sur l'ID joueur ; identifiants de compte remis dans l'app). "
    + "RÈGLE : réponds TOI-MÊME, utilement et directement, à TOUTES les questions courantes (prix, produits, jeux, comment acheter/recharger/vendre, paiement, livraison, VPN, points, portefeuille, parrainage). "
    + "NE dis PAS « tapez admin » à la fin de tes réponses normales. Ne propose « admin » QUE dans 2 cas : (1) le client demande explicitement un humain/conseiller/administrateur ; (2) problème grave que tu ne peux pas résoudre (paiement débité sans livraison, remboursement, commande payée non reçue, compte piraté/suspendu, litige avec un vendeur). Dans tous les autres cas, réponds simplement SANS jamais mentionner l'admin. "
    + "Réponds TRÈS COURT (2 à 3 phrases max), dans la langue du client, poliment, 1 emoji max. Ne promets jamais de remboursement ou d'action que seul un humain peut faire. "
    + "Tu PEUX voir et analyser les images / captures d'écran que le client envoie : décris ce que tu vois et aide concrètement. "
    + (ctx ? ("\n\nINFORMATIONS ACTUELLES DE LA PLATEFORME (vrais produits/jeux/prix du moment) :\n" + ctx) : "");
  const history = Array.isArray(b.history) ? b.history.slice(-6) : [];
  const contents = [];
  history.forEach(h => { const t = String((h && h.text) || '').slice(0, 600); if (!t) return; contents.push({ role: (h.role === 'bot' || h.role === 'model') ? 'model' : 'user', parts: [{ text: t }] }); });
  contents.push({ role: 'user', parts: [{ text: String(b.message || '').slice(0, 1500) }] });
  if (b.imageUrl) {
    try {
      const safe = await safeImageUrl(b.imageUrl);
      if (safe) {
        const ir = await fetch(safe, { redirect: 'error' });
        const ct = (ir.headers.get('content-type') || '').split(';')[0];
        const len = +(ir.headers.get('content-length') || 0);
        if (ir.ok && /^image\//.test(ct) && (!len || len < 5000000)) {
          const b64 = Buffer.from(await ir.arrayBuffer()).toString('base64');
          if (b64 && b64.length < 6500000) contents[contents.length - 1].parts.push({ inlineData: { mimeType: ct, data: b64 } });
        }
      }
    } catch (e) {}
  }
  const _body = JSON.stringify({ systemInstruction: { parts: [{ text: sys }] }, contents, generationConfig: { maxOutputTokens: 240, temperature: 0.5 } });
  const MODELS = ['gemini-flash-lite-latest', 'gemini-3.6-flash', 'gemini-flash-latest'];
  let lastErr = '';
  for (const model of MODELS) {
    try {
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + encodeURIComponent(KEY), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: _body });
      const d = await r.json();
      let text = '';
      try { text = (((d.candidates || [])[0] || {}).content || {}).parts.map(p => p.text || '').join(''); } catch (e) { text = ''; }
      if (text) return { reply: text.trim(), model };
      lastErr = (d && d.error && d.error.message) ? d.error.message : ('HTTP ' + r.status);
      if (!/not (found|available|supported)|is not|does not exist/i.test(lastErr)) break;
    } catch (e) { lastErr = String((e && e.message) || e); }
  }
  return { reply: '', err: 'Gemini: ' + String(lastErr).slice(0, 160) };
}

// Ventes entre particuliers : notifie l'autre partie (texte fixe)
async function marketplaceNotify(user, b) {
  const { data: row } = await L.supa().from('marketplace_orders').select('buyer_id,seller_id,status,data').eq('id', String(b.orderId || '')).maybeSingle();
  if (!row) return { error: 'Demande introuvable', status: 404 };
  const o = row.data || {};
  const title = String(o.listingTitle || 'votre annonce').slice(0, 80);
  const img = o.listingImage || '';
  const ex = img ? { image: img } : {};
  if (b.event === 'new') {
    if (row.buyer_id !== user.uid) return { error: 'Accès refusé', status: 403 };
    await L.notify(row.seller_id, '🛒', 'Nouvelle demande d\'achat', 'Un client veut acheter « ' + title + ' ». Vérifiez le paiement dans votre tableau de bord.', 'seller', 'seller', ex);
  } else if (b.event === 'confirmed' || b.event === 'refused') {
    if (row.seller_id !== user.uid) return { error: 'Accès refusé', status: 403 };
    if (b.event === 'confirmed' && row.status === 'confirmed') await L.notify(row.buyer_id, '✅', 'Achat confirmé', 'Votre compte « ' + title + ' » est livré ! Voir les accès dans Mon profil → Mes achats.', 'account', 'account', ex);
    else if (b.event === 'refused' && row.status === 'refused') await L.notify(row.buyer_id, '❌', 'Demande refusée', 'Le vendeur a refusé « ' + title + ' ».', 'account', 'account', ex);
  } else return { error: 'Événement inconnu', status: 400 };
  return { ok: true };
}

module.exports = async (req, res) => {
  L.cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const payload = L.body(req);

  try {
    const internal = L.isInternal(req);
    const user = internal ? null : await L.getAuthUser(req);

    if (payload.mode === 'gemini') {
      if (!user) return res.status(401).json({ reply: '', err: 'Connectez-vous pour utiliser l\'assistant.' });
      return res.status(200).json(await geminiReply(payload));
    }
    if (payload.mode === 'mkt') {
      if (!user) return res.status(401).json({ error: 'Non authentifié' });
      const r = await marketplaceNotify(user, payload);
      return res.status(r.status || 200).json(r);
    }
    if (payload.mode === 'support') {
      if (!user) return res.status(401).json({ error: 'Non authentifié' });
      const nm = String(user.name || (user.email || '').split('@')[0] || 'Un client').slice(0, 40);
      try { await L.notifyAdmin('💬', 'Nouveau message support', nm + ' attend une réponse dans la messagerie.', 'message', 'message'); } catch (e) {}
      return res.status(200).json({ ok: true });
    }

    // Réservé admin / serveur
    if (!internal && !(user && user.isAdmin)) return res.status(403).json({ error: 'Réservé à l\'administrateur' });

    const { userId, token, title, body, type } = payload;
    const pushExtra = payload.image ? { image: String(payload.image) } : {};

    let emailSent = false;
    if (payload.email && payload.email.to) {
      try { emailSent = await require('./_email.js').sendEmail(payload.email.to, payload.email.subject || 'MgLoot', payload.email.html || ''); }
      catch (e) { emailSent = false; }
    }
    if (payload.emailOnly) return res.status(200).json({ ok: true, emailSent });

    if (token && !userId) {
      const r1 = await L.sendToTokens([{ t: String(token), native: false }], title, body, type || 'announce', pushExtra);
      return res.status(200).json({ ok: true, sent: r1.sent || 0, emailSent });
    }
    const r = await L.pushTo(userId || null, title, body, type, pushExtra);
    return res.status(200).json({ ok: true, sent: r.sent || 0, emailSent });
  } catch (e) {
    console.error('[send-push]', e);
    return res.status(500).json({ error: e.message });
  }
};

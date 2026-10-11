// ════════════════════════════════════════════════════════════════
//  MgLoot — /api/mgloot-plus  — version Supabase
//   • action:'trial'      → badge Bronze 7 j (RPC plus_trial)
//   • action:'buy-wallet' → {idx, dur} : prix relu dans config, RPC plus_buy_wallet
// ════════════════════════════════════════════════════════════════
const L = require('./_supabase.js');
const PLUS_DAYS = { m1: 30, m3: 90, m12: 365 };
const PLUS_NAMES = { 7: 'Bronze', 8: 'Améthyste', 9: 'Émeraude', 10: 'Bleu vérifié' };
const PAID_IDX = [8, 9, 10];

module.exports = async (req, res) => {
  L.cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const user = await L.getAuthUser(req);
    if (!user) return res.status(401).json({ error: 'Connectez-vous pour continuer.' });
    const p = L.body(req);
    const uid = user.uid;

    if (p.action === 'trial') {
      const r = await L.rpc('plus_trial', { p_uid: uid });
      try { await L.notify(uid, '🎁', 'Essai Bronze activé', 'Votre badge Bronze est actif pendant 7 jours. Profitez-en !', 'certificate', 'certificates'); } catch (e) {}
      return res.status(200).json({ ok: true, certBadge: { idx: 7, expireAt: r.expMs } });
    }

    if (p.action === 'buy-wallet') {
      const idx = +p.idx || 0;
      const dur = String(p.dur || '');
      if (PAID_IDX.indexOf(idx) < 0 || !PLUS_DAYS[dur]) return res.status(400).json({ error: 'Badge invalide.' });
      const { data: cfgRow } = await L.supa().from('config').select('data').eq('id', 'shop').maybeSingle();
      const prices = (cfgRow && cfgRow.data && cfgRow.data.plusPrices) || {};
      const price = Math.round((+(((prices[String(idx)]) || {})[dur]) || 0) * 100) / 100;
      if (!(price > 0)) return res.status(400).json({ error: 'Prix du badge non configuré.' });
      const r = await L.rpc('plus_buy_wallet', { p_uid: uid, p_idx: idx, p_dur: dur, p_price: price });
      try { await L.notify(uid, '🪪', 'Badge activé', 'Votre badge « ' + (PLUS_NAMES[idx] || 'vérifié') + ' » MgLoot Plus est actif. Il s\'affiche à côté de votre nom.', 'certificate', 'certificates'); } catch (e) {}
      return res.status(200).json({ ok: true, certBadge: { idx, expireAt: r.expMs }, walletBalance: r.walletBalance });
    }

    return res.status(400).json({ error: 'Action inconnue.' });
  } catch (e) {
    if (e instanceof L.UserError) return res.status(400).json({ error: e.message });
    console.error('[mgloot-plus]', e);
    return res.status(500).json({ error: 'Erreur serveur : ' + String((e && e.message) || e).slice(0, 220) });
  }
};

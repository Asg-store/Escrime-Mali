// ════════════════════════════════════════════════════════════════
//  MgLoot — /api/redeem-giftcard  — version Supabase
//  Échange sécurisé d'une carte cadeau via la RPC atomique redeem_giftcard.
//  Body (POST JSON) : { code }   Header : Authorization: Bearer <jeton Supabase>
// ════════════════════════════════════════════════════════════════
const L = require('./_supabase.js');

module.exports = async (req, res) => {
  L.cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const user = await L.getAuthUser(req);
    if (!user) return res.status(401).json({ error: 'Non authentifié' });
    const p = L.body(req);
    const code = String((p && p.code) || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ error: 'Entrez un code.' });

    const r = await L.rpc('redeem_giftcard', { p_uid: user.uid, p_code: code });
    if (r && r.error === 'toomany') return res.status(200).json({ error: 'Trop d\'essais aujourd\'hui. Réessayez demain.' });
    if (r && r.error === 'used') return res.status(200).json({ error: 'Code déjà utilisé.' });
    if (r && r.error === 'invalid') return res.status(200).json({ error: 'Code invalide.' });
    return res.status(200).json({ ok: true, value: (r && r.value) || 0 });
  } catch (e) {
    if (e instanceof L.UserError) return res.status(400).json({ error: e.message });
    return res.status(500).json({ error: e.message });
  }
};

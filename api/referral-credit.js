// ════════════════════════════════════════════════════════════════
//  MgLoot — /api/referral-credit  — version Supabase
//  Crédite le parrain (et le filleul) via la RPC atomique credit_referral,
//  puis notifie le parrain (in-app + push FCM). Déclenché par le FILLEUL connecté.
// ════════════════════════════════════════════════════════════════
const L = require('./_supabase.js');
const MAX_ACCOUNT_AGE_MS = 7 * 24 * 3600 * 1000;

module.exports = async (req, res) => {
  L.cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const me = await L.getAuthUser(req);
    if (!me) return res.status(401).json({ error: 'Non authentifié' });
    const newUserId = me.uid;
    const u = me.token || {};

    // Anti-fraude : compte récent + e-mail vérifié (code e-mail ou Google)
    const created = Date.parse(u.created_at || '') || 0;
    if (!created || Date.now() - created > MAX_ACCOUNT_AGE_MS) return res.status(200).json({ ok: true, note: 'compte trop ancien pour un parrainage' });
    const providers = ((u.app_metadata && u.app_metadata.providers) || []).concat((u.identities || []).map(i => i.provider));
    const google = providers.indexOf('google') >= 0;
    let verified = google || !!u.email_confirmed_at;
    if (!verified) return res.status(200).json({ ok: true, note: 'e-mail non vérifié' });

    // Récompense par filleul (config/shop)
    let inviteReward = 500, inviteGoal = 10;
    try {
      const { data: cfg } = await L.supa().from('config').select('data').eq('id', 'shop').maybeSingle();
      const c = (cfg && cfg.data) || {};
      if (+c.inviteReward > 0) inviteReward = +c.inviteReward;
      if (+c.inviteGoal > 0) inviteGoal = +c.inviteGoal;
    } catch (e) {}
    const perReferral = Math.max(1, Math.round(inviteReward / inviteGoal));

    const r = await L.rpc('credit_referral', { p_new_uid: newUserId, p_per: perReferral });
    if (!r || !r.credited) return res.status(200).json({ ok: true, note: (r && r.note) || 'non crédité' });
    const referrerId = r.referrerId, referrerCount = r.count;

    // Nom du filleul (pour la notif)
    let friendName = 'Un ami';
    try {
      const { data: nu } = await L.supa().from('profiles').select('display_name,email,data').eq('id', newUserId).maybeSingle();
      const d = nu || {};
      friendName = d.display_name || (d.data && d.data.name) || (d.email ? String(d.email).split('@')[0] : 'Un ami');
    } catch (e) {}

    const goalReached = (referrerCount % inviteGoal === 0);
    const notifTitle = '🎉 Parrainage réussi !';
    const notifBody = friendName + ' vient de s\'inscrire avec votre lien. Vous gagnez +' + perReferral + ' points ⭐ (' + referrerCount + ' ami' + (referrerCount > 1 ? 's' : '') + ' invité' + (referrerCount > 1 ? 's' : '') + ')' + (goalReached ? ' — objectif atteint, bravo !' : '') + '.';
    try { await L.notify(referrerId, '🎁', notifTitle, notifBody, 'referral', 'invite', { refId: newUserId }); } catch (e) {}

    return res.status(200).json({ ok: true, referrerId, pointsAwarded: perReferral, referralCount: referrerCount });
  } catch (e) {
    if (e instanceof L.UserError) return res.status(400).json({ error: e.message });
    return res.status(500).json({ error: e.message });
  }
};

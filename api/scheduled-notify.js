// ════════════════════════════════════════════════════════════════
//  MgLoot — /api/scheduled-notify  — version Supabase (CRON 1×/jour)
//  1) Notifications programmées (scheduled_notifs).
//  2) 💎 Rappels d'expiration du badge Plus + relances non-abonnés.
// ════════════════════════════════════════════════════════════════
const L = require('./_supabase.js');
const E = require('./_email.js');
const sb = () => L.supa();

const PLUS_NAMES = { 7: 'Bronze', 8: 'Améthyste', 9: 'Émeraude', 10: 'Bleu vérifié' };
const PROMO_EVERY_MS = 10 * 86400000;
const PROMO_CAP = 30;
const SCAN_LIMIT = 600;

async function plusDailyJobs() {
  const now = Date.now();
  const WIN_LO = now + 3 * 86400000 - 12 * 3600000;
  const WIN_HI = now + 3 * 86400000 + 12 * 3600000;
  let expiryReminders = 0, promos = 0;
  let rows;
  try { const r = await sb().from('profiles').select('id,email,account_status,server_data').limit(SCAN_LIMIT); rows = r.data || []; }
  catch (e) { return { expiryReminders: 0, promos: 0 }; }

  for (const row of rows) {
    const sd = row.server_data || {};
    if (row.account_status === 'blocked' || row.account_status === 'deleted') continue;
    const cb = sd.certBadge || {};
    const expMs = +cb.expireMs || 0;

    if (expMs >= WIN_LO && expMs <= WIN_HI && +sd.plusRemindedExpireMs !== expMs) {
      const days = Math.max(1, Math.round((expMs - now) / 86400000));
      const isTrial = cb.source === 'trial';
      const name = PLUS_NAMES[+cb.idx] || 'vérifié';
      const title = isTrial ? 'Essai bientôt terminé' : 'Abonnement bientôt expiré';
      const body = (isTrial ? 'Votre essai gratuit' : 'Votre badge « ' + name + ' »') + ' MgLoot Plus expire dans ' + days + ' jour' + (days > 1 ? 's' : '') + '. Renouvelez pour garder vos avantages ⭐';
      try { await L.notify(row.id, '⏳', title, body, 'certificate', 'certificates'); } catch (e) {}
      if (row.email) {
        const inner = '<h2 style="color:#1d9bf6;margin:0 0 10px">⏳ ' + title + '</h2><p>Bonjour,</p>'
          + '<p>' + (isTrial ? 'Votre <b>essai gratuit</b>' : 'Votre badge <b>' + name + '</b>') + ' MgLoot Plus expire dans <b>' + days + ' jour' + (days > 1 ? 's' : '') + '</b>.</p>'
          + '<p>Renouvelez dès maintenant pour garder votre badge vérifié et tous vos avantages.</p>'
          + '<p><a href="' + L.BASE_URL + '/?open=certificates" style="display:inline-block;background:#1d9bf6;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:700">Renouveler mon abonnement</a></p><p>À bientôt,<br>L\'équipe MgLoot</p>';
        try { await E.sendEmail(row.email, 'MgLoot — Votre abonnement expire bientôt ⏳', E.wrap(inner)); } catch (e) {}
      }
      try { await sb().from('profiles').update({ server_data: Object.assign({}, sd, { plusRemindedExpireMs: expMs }) }).eq('id', row.id); } catch (e) {}
      expiryReminders++;
      continue;
    }

    if (!(expMs > now) && promos < PROMO_CAP) {
      const last = +sd.plusPromoAt || 0;
      if (last && (now - last) < PROMO_EVERY_MS) continue;
      try { await L.notify(row.id, '💎', 'Passez à MgLoot Plus', 'Obtenez un badge vérifié à côté de votre nom : plus de confiance, plus de ventes, et des avantages exclusifs ⭐', 'certificate', 'certificates'); } catch (e) {}
      if (row.email) {
        const inner = '<h2 style="color:#7c3aed;margin:0 0 10px">💎 Découvrez MgLoot Plus</h2><p>Bonjour,</p>'
          + '<p>Passez à <b>MgLoot Plus</b> et obtenez un <b>badge vérifié</b> : plus de confiance des acheteurs, plus de ventes, et des avantages exclusifs.</p>'
          + '<p><a href="' + L.BASE_URL + '/?open=certificates" style="display:inline-block;background:#7c3aed;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:700">Voir les offres MgLoot Plus</a></p><p>À bientôt,<br>L\'équipe MgLoot</p>';
        try { await E.sendEmail(row.email, 'MgLoot — Découvrez MgLoot Plus 💎', E.wrap(inner)); } catch (e) {}
      }
      try { await sb().from('profiles').update({ server_data: Object.assign({}, sd, { plusPromoAt: now }) }).eq('id', row.id); } catch (e) {}
      promos++;
    }
  }
  return { expiryReminders, promos };
}

module.exports = async (req, res) => {
  try {
    const nowMs = Date.now();
    const { data: pend } = await sb().from('scheduled_notifs').select('*').eq('sent', false).limit(50);
    const dueDocs = (pend || []).filter(d => { const ms = d.send_at ? Date.parse(d.send_at) : 0; return ms && ms <= nowMs; });

    const { data: tokRows } = await sb().from('fcm_tokens').select('token,user_id,platform,host,updated_at');
    const tokenInfo = L.uniqueTokenInfo(tokRows || []);
    const results = [];
    for (const d of dueDocs) {
      const n = d.data || {};
      let sentCount = 0;
      if (tokenInfo.length) { const r = await L.sendToTokens(tokenInfo, n.title || 'MgLoot', n.body || '', String(n.link || n.type || 'announce'), { notifId: d.id }); sentCount = r.sent || 0; }
      await sb().from('scheduled_notifs').update({ sent: true, data: Object.assign({}, n, { sentAt: new Date().toISOString(), sentCount }) }).eq('id', d.id);
      results.push({ id: d.id, title: n.title || '', sent: sentCount });
    }

    let plus = { expiryReminders: 0, promos: 0 };
    try { plus = await plusDailyJobs(); } catch (e) {}

    return res.status(200).json({ ok: true, due: dueDocs.length, devices: tokenInfo.length, results, expiryReminders: plus.expiryReminders, promos: plus.promos });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Erreur serveur' });
  }
};

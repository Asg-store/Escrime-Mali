// ════════════════════════════════════════════════════════════════
//  MgLoot — /api/reset-password  — version Supabase
//  Code à 4 chiffres par e-mail. Codes stockés dans password_resets /
//  signup_codes (Supabase). Changement de mot de passe via l'API admin Supabase.
//
//  Actions : send | verify | confirm | signup-send | signup-verify
// ════════════════════════════════════════════════════════════════
const L = require('./_supabase.js');
const crypto = require('crypto');
const sb = () => L.supa();

const CODE_TTL_MIN = 10, MAX_ATTEMPTS = 5, RESEND_WAIT_S = 60, MAX_SENDS_DAY = 5;

const norm = (e) => String(e || '').trim().toLowerCase();
const docId = (e) => Buffer.from(norm(e)).toString('hex').slice(0, 480);
const hash = (c, e) => crypto.createHash('sha256').update(String(c) + '|' + norm(e)).digest('hex');
const gen4 = () => String(crypto.randomInt(0, 10000)).padStart(4, '0');

async function getRow(table, id) { const { data } = await sb().from(table).select('data').eq('id', id).maybeSingle(); return data ? (data.data || {}) : null; }
async function setRow(table, id, data) { await sb().from(table).upsert({ id, data }); }

function sendQuota(prev) {
  const now = Date.now();
  const d = prev || {};
  const start = +d.quotaStart || 0;
  const fresh = !start || (now - start) > 24 * 3600 * 1000;
  const count = fresh ? 0 : (+d.quotaCount || 0);
  return { ok: count < MAX_SENDS_DAY, quotaStart: fresh ? now : start, quotaCount: count + 1 };
}
// Vérifie un code (lecture + écriture ; quota journalier + expiration limitent le risque)
async function checkCode(table, id, email, code) {
  const d = await getRow(table, id);
  if (!d) return { status: 400, error: 'Aucun code en cours. Demandez un nouveau code.' };
  if (Date.now() > (d.expiresAt || 0)) { await setRow(table, id, Object.assign({}, d, { codeHash: null, attempts: MAX_ATTEMPTS })); return { status: 400, error: 'Code expiré. Demandez un nouveau code.' }; }
  if (!d.codeHash || (d.attempts || 0) >= MAX_ATTEMPTS) return { status: 429, error: 'Trop de tentatives. Demandez un nouveau code.' };
  if (d.codeHash !== hash(code, email)) {
    const n = (d.attempts || 0) + 1;
    await setRow(table, id, Object.assign({}, d, { attempts: n }));
    const left = MAX_ATTEMPTS - n;
    return { status: 400, error: 'Code incorrect.' + (left > 0 ? ' Il vous reste ' + left + ' tentative(s).' : '') };
  }
  return { ok: true, data: d };
}

async function profileByEmail(email) { const { data } = await sb().from('profiles').select('id,display_name').eq('email', email).maybeSingle(); return data || null; }

function emailHtml(code, name) {
  const digits = String(code).split('').map((d) => `<td style="padding:0 5px"><div style="width:52px;height:62px;line-height:62px;text-align:center;border-radius:12px;background:#0f1830;border:1px solid #2a3a5e;color:#ffc83d;font-size:30px;font-weight:800;font-family:'Courier New',monospace">${d}</div></td>`).join('');
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#070b16"><table width="100%" cellpadding="0" cellspacing="0" style="background:#070b16;padding:28px 12px"><tr><td align="center"><table width="100%" cellpadding="0" cellspacing="0" style="max-width:460px;background:#0b1224;border:1px solid #1e2d4a;border-radius:20px;overflow:hidden"><tr><td style="padding:24px 26px 8px;text-align:center"><div style="font-size:22px;font-weight:800;color:#ffc83d;font-family:Arial">MGLOOT</div><div style="font-size:12px;color:#8ea0c0;font-family:Arial;margin-top:4px">Boutique gaming</div></td></tr><tr><td style="padding:14px 26px 0;text-align:center"><div style="font-size:18px;font-weight:700;color:#fff;font-family:Arial">🔑 Réinitialisation du mot de passe</div><p style="font-size:14px;color:#b9c6dd;line-height:1.6;font-family:Arial">Bonjour ${name ? String(name).replace(/[<>]/g, '') : ''},<br>Voici votre <b>code de vérification</b> à saisir dans l'application :</p></td></tr><tr><td align="center" style="padding:6px 20px 4px"><table cellpadding="0" cellspacing="0"><tr>${digits}</tr></table></td></tr><tr><td style="padding:10px 26px 24px;text-align:center"><p style="font-size:12.5px;color:#8ea0c0;line-height:1.6;font-family:Arial">Ce code expire dans <b>${CODE_TTL_MIN} minutes</b>.<br>Si vous n'êtes pas à l'origine de cette demande, ignorez cet e-mail.</p></td></tr></table><div style="font-size:11px;color:#5c6c8a;margin-top:14px;font-family:Arial">© MgLoot · Mali</div></td></tr></table></body></html>`;
}
async function sendMail(to, code, name) {
  const E = require('./_email.js');
  const ok = await E.sendEmail(to, `${code} — votre code de vérification MgLoot`, emailHtml(code, name));
  if (!ok) throw new Error('Échec de l\'envoi de l\'e-mail (service e-mail non configuré ?).');
}

module.exports = async (req, res) => {
  L.cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let p = L.body(req);
  const action = p.action || 'send';
  const email = norm(p.email);
  if (!email || email.indexOf('@') < 0) return res.status(400).json({ error: 'Adresse e-mail invalide.' });

  try {
    const pid = docId(email);

    if (action === 'signup-send') {
      if (await profileByEmail(email)) return res.status(409).json({ error: 'Un compte existe déjà avec cet e-mail. Connectez-vous.' });
      const prev = await getRow('signup_codes', pid);
      if (prev && prev.sentAt) { const wait = RESEND_WAIT_S * 1000 - (Date.now() - prev.sentAt); if (wait > 0) return res.status(429).json({ error: 'Patientez ' + Math.ceil(wait / 1000) + 's avant de redemander un code.' }); }
      const q = sendQuota(prev);
      if (!q.ok) return res.status(429).json({ error: 'Trop de codes demandés aujourd\'hui. Réessayez demain.' });
      const code = gen4();
      await sendMail(email, code, (p.name || ''));
      await setRow('signup_codes', pid, { email, codeHash: hash(code, email), expiresAt: Date.now() + CODE_TTL_MIN * 60000, attempts: 0, verified: false, sentAt: Date.now(), quotaStart: q.quotaStart, quotaCount: q.quotaCount });
      return res.status(200).json({ ok: true, sent: true, ttl: CODE_TTL_MIN });
    }
    if (action === 'signup-verify') {
      const c = String(p.code || '').replace(/\D/g, '');
      if (c.length !== 4) return res.status(400).json({ error: 'Le code doit contenir 4 chiffres.' });
      const ck = await checkCode('signup_codes', pid, email, c);
      if (!ck.ok) return res.status(ck.status).json({ error: ck.error });
      await setRow('signup_codes', pid, Object.assign({}, ck.data, { verified: true, verifiedAt: Date.now() }));
      return res.status(200).json({ ok: true, verified: true });
    }

    if (action === 'send') {
      const prof = await profileByEmail(email);
      if (!prof) return res.status(404).json({ error: 'Aucun compte n\'est associé à cette adresse e-mail.' });
      const prev = await getRow('password_resets', pid);
      if (prev && prev.sentAt) { const wait = RESEND_WAIT_S * 1000 - (Date.now() - prev.sentAt); if (wait > 0) return res.status(429).json({ error: 'Patientez ' + Math.ceil(wait / 1000) + 's avant de redemander un code.' }); }
      const q = sendQuota(prev);
      if (!q.ok) return res.status(429).json({ error: 'Trop de codes demandés aujourd\'hui. Réessayez demain.' });
      const code = gen4();
      await sendMail(email, code, prof.display_name || '');
      await setRow('password_resets', pid, { email, uid: prof.id, codeHash: hash(code, email), expiresAt: Date.now() + CODE_TTL_MIN * 60000, attempts: 0, verified: false, sentAt: Date.now(), quotaStart: q.quotaStart, quotaCount: q.quotaCount });
      return res.status(200).json({ ok: true, sent: true, ttl: CODE_TTL_MIN });
    }

    const code = String(p.code || '').replace(/\D/g, '');
    if (code.length !== 4) return res.status(400).json({ error: 'Le code doit contenir 4 chiffres.' });
    const ck = await checkCode('password_resets', pid, email, code);
    if (!ck.ok) return res.status(ck.status).json({ error: ck.error });
    const d = ck.data;

    if (action === 'verify') {
      await setRow('password_resets', pid, Object.assign({}, d, { verified: true }));
      return res.status(200).json({ ok: true, verified: true });
    }
    if (action === 'confirm') {
      const np = String(p.newPassword || '');
      if (np.length < 6) return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères.' });
      const { error } = await sb().auth.admin.updateUserById(d.uid, { password: np });
      if (error) return res.status(500).json({ error: error.message });
      await setRow('password_resets', pid, Object.assign({}, d, { codeHash: null, attempts: MAX_ATTEMPTS, verified: false }));
      return res.status(200).json({ ok: true, updated: true });
    }
    return res.status(400).json({ error: 'Action inconnue.' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Erreur serveur.' });
  }
};

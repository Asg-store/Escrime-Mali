/* ════════════════════════════════════════════════════════════════
   MgLoot — supabase-shim.js
   Couche d'adaptation : réimplémente l'API Firebase « compat » utilisée par
   le client (firestore + auth + storage) EN TAPANT SUR SUPABASE.
   FCM reste géré par le vrai firebase (app + messaging) — ce shim ne touche
   PAS à firebase.messaging().

   À charger APRÈS supabase-js (UMD) et APRÈS firebase-app-compat +
   firebase-messaging-compat, et AVANT le script d'init du site.

   Config attendue (définie dans la page avant ce fichier) :
     window.SUPABASE_URL = "https://xxxx.supabase.co";
     window.SUPABASE_ANON_KEY = "ey...";

   ⚠️ À TESTER sur la preview avant toute mise en production (site d'argent).
   ════════════════════════════════════════════════════════════════ */
(function () {
  if (!window.supabase || !window.supabase.createClient) { console.error('[shim] supabase-js non chargé'); return; }
  var _sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  window._sb = _sb;

  // ── Table d'une "collection" Firestore ──
  var TABLE = {
    users: 'profiles', config: 'config', products: 'products', pointsProducts: 'points_products',
    games: 'games', promos: 'promos', orders: 'orders', accounts: 'accounts',
    accountPurchases: 'account_purchases', accountOrders: 'account_orders',
    vpnFiles: 'vpn_files', vpnPurchases: 'vpn_purchases', chats: 'chats',
    walletRequests: 'wallet_requests', moneyfusionPayments: 'moneyfusion_payments',
    payments: 'payments', giftcards: 'giftcards', redemptions: 'redemptions',
    pointsHistory: 'points_history', referrals: 'referrals', reviews: 'reviews',
    sellerRatings: 'seller_ratings', reports: 'reports', marketplaceOrders: 'marketplace_orders',
    fcmTokens: 'fcm_tokens', scheduledNotifs: 'scheduled_notifs', announcements: 'announcements',
    flashOffers: 'flash_offers', screenAds: 'screen_ads', missions: 'missions',
    pinResets: 'pin_resets', stockCodes: 'stock_codes'
  };
  // Colonnes réelles par table (camelCase du client ↔ colonne snake_case).
  // Tout le reste d'un document va dans la colonne jsonb `data`.
  var COLS = {
    profiles: { userId: 'id', id: 'id', firebaseUid: 'firebase_uid', email: 'email', displayName: 'display_name', walletBalance: 'wallet_balance', points: 'points', loyaltyXP: 'loyalty_xp', orderCount: 'order_count', totalSpent: 'total_spent', role: 'role', accountStatus: 'account_status', suspendUntil: 'suspend_until', sellBanned: 'sell_banned', signupBonusGiven: 'signup_bonus_given', createdAt: 'created_at', updatedAt: 'updated_at' },
    orders: { userId: 'user_id', status: 'status', total: 'total', paymentMethod: 'payment_method', promoCode: 'promo_code', rewarded: 'rewarded', items: 'items', createdAt: 'created_at', updatedAt: 'updated_at' },
    accounts: { userId: 'user_id', status: 'status', isOfficial: 'is_official', promoted: 'promoted', promotedUntil: 'promoted_until', views: 'views', soldTo: 'sold_to', createdAt: 'created_at', updatedAt: 'updated_at' },
    account_purchases: { userId: 'user_id', accountId: 'account_id', createdAt: 'created_at' },
    account_orders: { userId: 'user_id', status: 'status', hiddenByUser: 'hidden_by_user', createdAt: 'created_at', updatedAt: 'updated_at' },
    products: { active: 'active', order: 'order', createdAt: 'created_at', updatedAt: 'updated_at' },
    points_products: { active: 'active', order: 'order', createdAt: 'created_at', updatedAt: 'updated_at' },
    games: { active: 'active', order: 'order', createdAt: 'created_at', updatedAt: 'updated_at' },
    config: { updatedAt: 'updated_at' },
    promos: { code: 'code', active: 'active', createdAt: 'created_at', updatedAt: 'updated_at' },
    flash_offers: { active: 'active', createdAt: 'created_at' },
    screen_ads: { active: 'active', createdAt: 'created_at' },
    missions: { active: 'active', order: 'order', createdAt: 'created_at' },
    announcements: { createdAt: 'created_at' },
    vpn_files: { active: 'active', createdAt: 'created_at', updatedAt: 'updated_at' },
    vpn_purchases: { userId: 'user_id', fileId: 'file_id', createdAt: 'created_at' },
    wallet_requests: { userId: 'user_id', status: 'status', createdAt: 'created_at', updatedAt: 'updated_at' },
    moneyfusion_payments: { userId: 'user_id', uid: 'user_id', status: 'status', createdAt: 'created_at', updatedAt: 'updated_at' },
    payments: { userId: 'user_id', status: 'status', createdAt: 'created_at', updatedAt: 'updated_at' },
    giftcards: { code: 'code', createdAt: 'created_at' },
    redemptions: { userId: 'user_id', status: 'status', createdAt: 'created_at', updatedAt: 'updated_at' },
    points_history: { userId: 'user_id', createdAt: 'created_at' },
    referrals: { userId: 'user_id', referrerId: 'referrer_id', status: 'status', createdAt: 'created_at', updatedAt: 'updated_at' },
    reviews: { userId: 'user_id', createdAt: 'created_at' },
    seller_ratings: { sellerId: 'seller_id', buyerId: 'buyer_id', value: 'value', createdAt: 'created_at', updatedAt: 'updated_at' },
    reports: { reporterId: 'reporter_id', createdAt: 'created_at' },
    marketplace_orders: { buyerId: 'buyer_id', sellerId: 'seller_id', status: 'status', createdAt: 'created_at', updatedAt: 'updated_at' },
    fcm_tokens: { token: 'token', userId: 'user_id', userEmail: 'user_email', platform: 'platform', host: 'host', updatedAt: 'updated_at' },
    scheduled_notifs: { sent: 'sent', sendAt: 'send_at', createdAt: 'created_at' },
    pin_resets: { userId: 'user_id', status: 'status', createdAt: 'created_at', updatedAt: 'updated_at' },
    notifications: { userId: 'user_id', icon: 'icon', title: 'title', body: 'body', type: 'type', link: 'link', read: 'read', createdAt: 'created_at' },
    wallet_history: { userId: 'user_id', amount: 'amount', reason: 'reason', createdAt: 'created_at' },
    stock_codes: { createdAt: 'created_at' }
  };
  var camelOf = {}; // table → {snake: camel}
  Object.keys(COLS).forEach(function (t) { camelOf[t] = {}; Object.keys(COLS[t]).forEach(function (c) { camelOf[t][COLS[t][c]] = c; }); });

  // ── Timestamp compat ──
  function TS(d) { this._d = (d instanceof Date) ? d : new Date(d); }
  TS.prototype.toMillis = function () { return this._d.getTime(); };
  TS.prototype.toDate = function () { return this._d; };
  Object.defineProperty(TS.prototype, 'seconds', { get: function () { return Math.floor(this._d.getTime() / 1000); } });
  function wrapVal(v) {
    if (typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(v)) { var d = new Date(v); if (!isNaN(d)) return new TS(d); }
    return v;
  }

  // ── Sentinels FieldValue ──
  var INC = '__inc__', AU = '__arrUnion__', AR = '__arrRemove__', DEL = '__delete__', SRV = '__serverTs__';
  function isSentinel(v) { return v && typeof v === 'object' && v.__fv__; }

  // Transforme une ligne Supabase → document plat « Firestore »
  function rowToDoc(table, row) {
    if (!row) return null;
    var out = {};
    var data = row.data || {};
    Object.keys(data).forEach(function (k) { out[k] = wrapVal(data[k]); });
    var cm = camelOf[table] || {};
    Object.keys(row).forEach(function (sc) {
      if (sc === 'data' || sc === 'server_data') return;
      var camel = cm[sc] || sc;
      if (row[sc] !== null && row[sc] !== undefined) out[camel] = wrapVal(row[sc]);
    });
    // server_data (profils) : exposé en lecture, fusionné à plat
    if (row.server_data) Object.keys(row.server_data).forEach(function (k) { if (out[k] === undefined) out[k] = wrapVal(row.server_data[k]); });
    return out;
  }

  // Sépare un objet d'écriture → { cols:{snake:val}, dataPatch:{}, incs:[], unions:[], removes:[], dels:[] }
  function splitWrite(table, obj) {
    var cols = {}, dataPatch = {}, special = { incs: [], unions: [], removes: [], dels: [] };
    var map = COLS[table] || {};
    Object.keys(obj || {}).forEach(function (k) {
      var v = obj[k];
      var snake = map[k];
      if (isSentinel(v)) {
        // Sentinels : s'appliquent à data (lecture-modif-écriture) ; colonnes argent interdites au client (RLS)
        if (v.t === SRV) { if (snake) cols[snake] = new Date().toISOString(); else dataPatch[k] = new Date().toISOString(); return; }
        if (v.t === DEL) { special.dels.push(k); return; }
        if (v.t === INC) { special.incs.push({ k: k, n: v.n }); return; }
        if (v.t === AU) { special.unions.push({ k: k, vals: v.vals }); return; }
        if (v.t === AR) { special.removes.push({ k: k, vals: v.vals }); return; }
        return;
      }
      if (snake) cols[snake] = v; else dataPatch[k] = v;
    });
    return { cols: cols, dataPatch: dataPatch, special: special };
  }

  function applyData(existing, dataPatch, special, merge) {
    var d = merge ? Object.assign({}, existing || {}) : {};
    Object.keys(dataPatch).forEach(function (k) { d[k] = dataPatch[k]; });
    special.incs.forEach(function (x) { d[x.k] = (+d[x.k] || 0) + x.n; });
    special.unions.forEach(function (x) { var a = Array.isArray(d[x.k]) ? d[x.k].slice() : []; x.vals.forEach(function (v) { if (a.indexOf(v) < 0) a.push(v); }); d[x.k] = a; });
    special.removes.forEach(function (x) { var a = Array.isArray(d[x.k]) ? d[x.k].slice() : []; d[x.k] = a.filter(function (v) { return x.vals.indexOf(v) < 0; }); });
    special.dels.forEach(function (k) { delete d[k]; });
    return d;
  }

  // ── Requête (where/orderBy/limit) ──
  function Query(table, filters, parent) {
    this.table = table; this.filters = filters || []; this.parent = parent || null;
    this._order = null; this._limit = null;
  }
  Query.prototype.where = function (field, op, val) { var q = this._clone(); q.filters = q.filters.concat([{ field: field, op: op, val: val }]); return q; };
  Query.prototype.orderBy = function (field, dir) { var q = this._clone(); q._order = { field: field, dir: dir || 'asc' }; return q; };
  Query.prototype.limit = function (n) { var q = this._clone(); q._limit = n; return q; };
  Query.prototype._clone = function () { var q = new Query(this.table, this.filters.slice(), this.parent); q._order = this._order; q._limit = this._limit; return q; };
  Query.prototype._colFor = function (field) { return (COLS[this.table] && COLS[this.table][field]) || field; };
  Query.prototype._build = function () {
    var q = _sb.from(this.table).select('*');
    var self = this;
    if (this.parent) q = q.eq(this.parent.col, this.parent.val);
    this.filters.forEach(function (f) {
      var col = self._colFor(f.field);
      var isData = !(COLS[self.table] && COLS[self.table][f.field]) && !(self.parent && self.parent.col === col);
      var target = isData ? ('data->>' + f.field) : col;
      if (f.op === '==') q = q.eq(target, f.val);
      else if (f.op === '!=') q = q.neq(target, f.val);
      else if (f.op === '>') q = q.gt(target, f.val);
      else if (f.op === '>=') q = q.gte(target, f.val);
      else if (f.op === '<') q = q.lt(target, f.val);
      else if (f.op === '<=') q = q.lte(target, f.val);
      else if (f.op === 'in') q = q.in(target, f.val);
      else if (f.op === 'array-contains') q = q.contains(isData ? ('data->' + f.field) : col, [f.val]);
    });
    if (this._order) { var oc = this._colFor(this._order.field); q = q.order(oc, { ascending: this._order.dir !== 'desc' }); }
    if (this._limit) q = q.limit(this._limit);
    return q;
  };
  Query.prototype.get = function () {
    var self = this;
    return this._build().then(function (res) {
      var rows = res.data || [];
      return makeSnapshot(self.table, rows);
    });
  };
  Query.prototype.onSnapshot = function (cb, err) { return subscribe(this, cb, err); };

  function makeSnapshot(table, rows) {
    var docs = rows.map(function (r) { return makeDocSnap(table, r.id, r); });
    return { empty: docs.length === 0, size: docs.length, docs: docs, forEach: function (fn) { docs.forEach(fn); } };
  }
  function makeDocSnap(table, id, row) {
    var data = row ? rowToDoc(table, row) : null;
    return { id: id, exists: !!row, data: function () { return data; }, get: function (f) { return data ? data[f] : undefined; }, ref: new DocRef(table, id) };
  }

  // ── Référence de document ──
  function DocRef(table, id, parent) { this.table = table; this.id = id; this.parent = parent || null; }
  DocRef.prototype.collection = function (sub) { return subCollection(this, sub); };
  DocRef.prototype.get = function () {
    var self = this;
    var q = _sb.from(this.table).select('*').eq('id', this.id);
    if (this.parent) q = q.eq(this.parent.col, this.parent.val);
    return q.maybeSingle().then(function (res) { return makeDocSnap(self.table, self.id, res.data); });
  };
  DocRef.prototype._current = function () {
    var self = this; var q = _sb.from(this.table).select('*').eq('id', this.id);
    if (this.parent) q = q.eq(this.parent.col, this.parent.val);
    return q.maybeSingle().then(function (r) { return r.data; });
  };
  DocRef.prototype.set = function (obj, opts) {
    var self = this; var merge = !!(opts && opts.merge);
    var sw = splitWrite(this.table, obj);
    return (sw.special.incs.length || sw.special.unions.length || sw.special.removes.length || sw.special.dels.length || merge ? this._current() : Promise.resolve(null))
      .then(function (cur) {
        var row = Object.assign({ id: self.id }, sw.cols);
        if (self.parent) row[self.parent.col] = self.parent.val;
        var existingData = cur ? cur.data : {};
        row.data = applyData(existingData, sw.dataPatch, sw.special, merge);
        return _sb.from(self.table).upsert(row).then(chk);
      });
  };
  DocRef.prototype.update = function (obj) { return this.set(obj, { merge: true }); };
  DocRef.prototype.delete = function () {
    var q = _sb.from(this.table).delete().eq('id', this.id);
    if (this.parent) q = q.eq(this.parent.col, this.parent.val);
    return q.then(chk);
  };
  DocRef.prototype.onSnapshot = function (cb, err) { return subscribeDoc(this, cb, err); };

  function chk(res) { if (res && res.error) throw new Error(res.error.message || 'Erreur base'); return res; }

  // ── Collection ──
  function CollectionRef(table, parent) { Query.call(this, table, [], parent); }
  CollectionRef.prototype = Object.create(Query.prototype);
  CollectionRef.prototype.doc = function (id) { return new DocRef(this.table, id || genId(), this.parent); };
  CollectionRef.prototype.add = function (obj) {
    var self = this; var sw = splitWrite(this.table, obj);
    var id = genId();
    var row = Object.assign({ id: id }, sw.cols);
    if (this.parent) row[this.parent.col] = this.parent.val;
    row.data = applyData({}, sw.dataPatch, sw.special, false);
    return _sb.from(this.table).insert(row).then(function (res) { chk(res); return new DocRef(self.table, id, self.parent); });
  };

  // Sous-collections → table enfant + filtre parent
  function subCollection(docRef, sub) {
    var parentTable = docRef.table;
    if (parentTable === 'profiles' && sub === 'notifications') return new CollectionRef('notifications', { col: 'user_id', val: docRef.id });
    if (parentTable === 'profiles' && sub === 'walletHistory') return new CollectionRef('wallet_history', { col: 'user_id', val: docRef.id });
    if (parentTable === 'chats' && sub === 'messages') return new CollectionRef('messages', { col: 'chat_id', val: docRef.id });
    if (parentTable === 'accounts' && sub === 'private') return new SubDocMap('account_private', 'account_id', docRef.id);
    if (parentTable === 'vpn_files' && sub === 'secret') return new SubDocMap('vpn_secret', 'file_id', docRef.id);
    // défaut : table nommée = sub (rare)
    return new CollectionRef(TABLE[sub] || sub, { col: 'user_id', val: docRef.id });
  }
  // Cas spécial : account_private / vpn_secret = 1 ligne, les "docs" deviennent des clés dans data
  function SubDocMap(table, keyCol, keyVal) { this.table = table; this.keyCol = keyCol; this.keyVal = keyVal; }
  SubDocMap.prototype.doc = function (name) { return new SubDocRef(this.table, this.keyCol, this.keyVal, name); };
  function SubDocRef(table, keyCol, keyVal, name) { this.table = table; this.keyCol = keyCol; this.keyVal = keyVal; this.name = name; }
  SubDocRef.prototype.get = function () {
    var self = this;
    return _sb.from(this.table).select('data').eq(this.keyCol, this.keyVal).maybeSingle().then(function (r) {
      var d = r.data ? (r.data.data || {}) : null;
      var val = d ? (d[self.name] !== undefined ? d[self.name] : d) : null;
      return { exists: !!d, id: self.name, data: function () { return val; } };
    });
  };
  SubDocRef.prototype.set = function (obj, opts) {
    var self = this;
    return _sb.from(this.table).select('data').eq(this.keyCol, this.keyVal).maybeSingle().then(function (r) {
      var cur = r.data ? (r.data.data || {}) : {};
      cur[self.name] = Object.assign({}, (opts && opts.merge && cur[self.name]) || {}, obj);
      var row = {}; row[self.keyCol] = self.keyVal; row.data = cur;
      return _sb.from(self.table).upsert(row).then(chk);
    });
  };
  SubDocRef.prototype.update = function (obj) { return this.set(obj, { merge: true }); };

  function genId() { return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('xxxxxxxxxxxx'.replace(/x/g, function () { return (Math.random() * 16 | 0).toString(16); }) + Date.now()); }

  // ── Temps réel (Supabase Realtime) ──
  function subscribe(query, cb, err) {
    query.get().then(cb).catch(err || function () {});
    var ch = _sb.channel('q_' + query.table + '_' + Math.random().toString(36).slice(2))
      .on('postgres_changes', { event: '*', schema: 'public', table: query.table }, function () { query.get().then(cb).catch(function () {}); })
      .subscribe();
    return function () { try { _sb.removeChannel(ch); } catch (e) {} };
  }
  function subscribeDoc(docRef, cb, err) {
    docRef.get().then(cb).catch(err || function () {});
    var ch = _sb.channel('d_' + docRef.table + '_' + docRef.id + '_' + Math.random().toString(36).slice(2))
      .on('postgres_changes', { event: '*', schema: 'public', table: docRef.table, filter: 'id=eq.' + docRef.id }, function () { docRef.get().then(cb).catch(function () {}); })
      .subscribe();
    return function () { try { _sb.removeChannel(ch); } catch (e) {} };
  }

  // ── Firestore() ──
  function firestore() {
    return {
      collection: function (name) { return new CollectionRef(TABLE[name] || name, null); },
      doc: function (path) { var p = path.split('/'); return new DocRef(TABLE[p[0]] || p[0], p[1]); },
      runTransaction: function (fn) {
        // Pas de vraie transaction côté client : exécution optimiste (lecture-modif-écriture).
        // Les opérations d'ARGENT ne passent PAS par ici (elles sont sur /api/*).
        var tx = {
          get: function (ref) { return ref.get(); },
          set: function (ref, obj, opts) { return ref.set(obj, opts); },
          update: function (ref, obj) { return ref.update(obj); },
          delete: function (ref) { return ref.delete(); }
        };
        return Promise.resolve(fn(tx));
      },
      batch: function () {
        var ops = [];
        return {
          set: function (ref, obj, opts) { ops.push(function () { return ref.set(obj, opts); }); return this; },
          update: function (ref, obj) { ops.push(function () { return ref.update(obj); }); return this; },
          delete: function (ref) { ops.push(function () { return ref.delete(); }); return this; },
          commit: function () { return ops.reduce(function (pr, op) { return pr.then(op); }, Promise.resolve()); }
        };
      }
    };
  }
  firestore.FieldValue = {
    serverTimestamp: function () { return { __fv__: 1, t: SRV }; },
    increment: function (n) { return { __fv__: 1, t: INC, n: n }; },
    arrayUnion: function () { return { __fv__: 1, t: AU, vals: Array.prototype.slice.call(arguments) }; },
    arrayRemove: function () { return { __fv__: 1, t: AR, vals: Array.prototype.slice.call(arguments) }; },
    delete: function () { return { __fv__: 1, t: DEL }; }
  };
  firestore.Timestamp = { now: function () { return new TS(new Date()); }, fromDate: function (d) { return new TS(d); }, fromMillis: function (m) { return new TS(new Date(m)); } };

  // ── Auth() ──
  var authCbs = [];
  var _user = null;
  function mapUser(u) {
    if (!u) return null;
    return {
      uid: u.id, email: u.email || '',
      displayName: (u.user_metadata && (u.user_metadata.name || u.user_metadata.full_name)) || '',
      emailVerified: !!u.email_confirmed_at,
      getIdToken: function () { return _sb.auth.getSession().then(function (r) { return (r.data.session && r.data.session.access_token) || ''; }); },
      providerData: ((u.identities) || []).map(function (i) { return { providerId: i.provider === 'google' ? 'google.com' : i.provider }; })
    };
  }
  _sb.auth.onAuthStateChange(function (_e, session) {
    _user = session ? mapUser(session.user) : null;
    authCbs.forEach(function (cb) { try { cb(_user); } catch (e) {} });
  });
  function auth() {
    return {
      get currentUser() { return _user; },
      onAuthStateChanged: function (cb) {
        authCbs.push(cb);
        _sb.auth.getSession().then(function (r) { _user = r.data.session ? mapUser(r.data.session.user) : null; cb(_user); });
        return function () { var i = authCbs.indexOf(cb); if (i >= 0) authCbs.splice(i, 1); };
      },
      signInWithEmailAndPassword: function (email, pass) {
        return _sb.auth.signInWithPassword({ email: email, password: pass }).then(function (r) { if (r.error) throw new Error(r.error.message); return { user: mapUser(r.data.user) }; });
      },
      createUserWithEmailAndPassword: function (email, pass) {
        return _sb.auth.signUp({ email: email, password: pass }).then(function (r) { if (r.error) throw new Error(r.error.message); return { user: mapUser(r.data.user) }; });
      },
      signInWithPopup: function () { return _sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.origin } }).then(function () { return { user: null }; }); },
      signInWithRedirect: function () { return _sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.origin } }); },
      signOut: function () { return _sb.auth.signOut(); },
      sendPasswordResetEmail: function (email) { return _sb.auth.resetPasswordForEmail(email); }
    };
  }
  auth.GoogleAuthProvider = function () { return { providerId: 'google.com' }; };
  auth.EmailAuthProvider = { credential: function (email, pass) { return { email: email, password: pass }; } };

  // ── Storage() → Supabase Storage (bucket "uploads") ──
  function storage() {
    return {
      ref: function (path) {
        return {
          put: function (file) {
            var p = path || ('up/' + Date.now() + '_' + (file.name || 'file'));
            var task = _sb.storage.from('uploads').upload(p, file, { upsert: true }).then(function (r) { if (r.error) throw new Error(r.error.message); return r; });
            return { then: task.then.bind(task), catch: task.catch.bind(task), ref: { getDownloadURL: function () { return Promise.resolve(_sb.storage.from('uploads').getPublicUrl(p).data.publicUrl); } } };
          },
          getDownloadURL: function () { return Promise.resolve(_sb.storage.from('uploads').getPublicUrl(path).data.publicUrl); }
        };
      }
    };
  }

  // ── Branche le shim sur l'objet firebase (garde firebase.messaging intact) ──
  if (!window.firebase) window.firebase = {};
  window.firebase.firestore = firestore;
  window.firebase.auth = auth;
  window.firebase.storage = storage;
  // initializeApp reste géré par le vrai firebase-app-compat (pour messaging).
  console.log('[shim] Supabase prêt (firestore+auth+storage). FCM reste sur firebase.');
})();

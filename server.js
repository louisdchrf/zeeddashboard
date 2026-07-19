const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const { scryptSync, randomBytes, timingSafeEqual, webcrypto } = require('crypto');
const db = require('./db');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: false } });
// Capture du body brut avant parsing (nécessaire pour vérifier la signature Discord)
app.use(express.json({ verify: (req, _, buf) => { req.rawBody = buf; } }));

// ── Session store (SQLite, aucune dépendance supplémentaire) ──────────────────

class SQLiteStore extends session.Store {
  constructor(database) {
    super();
    this._db = database;
    setInterval(() => this._db.prepare('DELETE FROM sessions WHERE expired<?').run(Date.now()), 3600_000);
  }
  get(sid, cb) {
    try {
      const row = this._db.prepare('SELECT sess FROM sessions WHERE sid=? AND expired>?').get(sid, Date.now());
      cb(null, row ? JSON.parse(row.sess) : null);
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try {
      const expired = Date.now() + (sess.cookie?.maxAge || 7 * 86400_000);
      this._db.prepare('INSERT OR REPLACE INTO sessions (sid, sess, expired) VALUES (?,?,?)').run(sid, JSON.stringify(sess), expired);
      cb(null);
    } catch (e) { cb(e); }
  }
  destroy(sid, cb) {
    try { this._db.prepare('DELETE FROM sessions WHERE sid=?').run(sid); cb(null); } catch (e) { cb(e); }
  }
}

app.set('trust proxy', 1); // reverse proxy (nginx/caddy)

const sessionMiddleware = session({
  store: new SQLiteStore(db),
  secret: process.env.SESSION_SECRET || 'gta-dashboard-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 86400_000,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  },
});
app.use(sessionMiddleware);

// ── Socket.io — auth + présence ───────────────────────────────────────────────
io.use((socket, next) => sessionMiddleware(socket.request, {}, next));

const onlineUsers = new Map(); // socketId → {id, username, avatar, discord_id}

io.on('connection', (socket) => {
  const userId = socket.request.session?.userId;
  if (!userId) { socket.disconnect(); return; }
  const user = db.prepare('SELECT id, username, avatar, discord_id FROM users WHERE id=?').get(userId);
  if (!user) { socket.disconnect(); return; }

  onlineUsers.set(socket.id, user);
  io.emit('users:online', [...onlineUsers.values()]);

  socket.on('disconnect', () => {
    onlineUsers.delete(socket.id);
    io.emit('users:online', [...onlineUsers.values()]);
  });
});

function broadcast(event, data) { io.emit(event, data); }

app.use(express.static('public'));

// ── Helpers mot de passe ──────────────────────────────────────────────────────

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const computed = scryptSync(password, salt, 32);
  return timingSafeEqual(computed, Buffer.from(hash, 'hex'));
}

function discordNotifEnabled() { return getSetting('discord_notif_enabled') !== '0'; }

function getSetting(key) {
  return db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value ?? null;
}

function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)').run(key, value);
}

// ── Auth — routes publiques ───────────────────────────────────────────────────

// État de configuration (utilisé par le login screen)
app.get('/auth/config', (_, res) => {
  const adminExists       = !!getSetting('admin_password_hash');
  const discordConfigured = !!getSetting('discord_client_id');
  res.json({ adminExists, discordConfigured, version: process.env.BUILD_VERSION || 'dev' });
});

// Première configuration — création du compte admin
app.post('/auth/setup', (req, res) => {
  if (getSetting('admin_password_hash')) return res.status(403).json({ error: 'Admin déjà configuré' });
  const { username, password } = req.body;
  if (!username?.trim() || !password || password.length < 6)
    return res.status(400).json({ error: 'Identifiants invalides (mdp min. 6 caractères)' });

  const existing = db.prepare("SELECT id FROM users WHERE discord_id='__admin__'").get();
  let adminId;
  if (existing) {
    db.prepare("UPDATE users SET username=?, is_admin=1 WHERE discord_id='__admin__'").run(username.trim());
    adminId = existing.id;
  } else {
    const r = db.prepare("INSERT INTO users (discord_id, username, is_admin) VALUES ('__admin__', ?, 1)").run(username.trim());
    adminId = r.lastInsertRowid;
  }
  setSetting('admin_username', username.trim());
  setSetting('admin_password_hash', hashPassword(password));

  req.session.userId = adminId;
  req.session.save(() => res.json({ success: true }));
});

// Connexion admin
app.post('/auth/admin', (req, res) => {
  const storedHash = getSetting('admin_password_hash');
  const storedUser = getSetting('admin_username');
  if (!storedHash) return res.status(401).json({ error: 'Aucun admin configuré' });

  const { username, password } = req.body;
  if (username !== storedUser || !verifyPassword(password, storedHash))
    return res.status(401).json({ error: 'Identifiants incorrects' });

  const admin = db.prepare("SELECT id FROM users WHERE discord_id='__admin__'").get();
  req.session.userId = admin.id;
  req.session.save(() => res.json({ success: true }));
});

// Connexion Discord — credentials depuis la DB (configurés par l'admin)
app.get('/auth/discord', (req, res) => {
  const clientId    = getSetting('discord_client_id');
  const redirectUri = getSetting('discord_redirect_uri') || `${req.protocol}://${req.get('host')}/auth/discord/callback`;
  if (!clientId) return res.status(500).send('Discord non configuré — connecte-toi en admin et va dans Paramètres.');
  const url = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=identify%20guilds`;
  res.redirect(url);
});

app.get('/auth/discord/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?error=no_code');
  const clientId     = getSetting('discord_client_id');
  const clientSecret = getSetting('discord_client_secret');
  const redirectUri  = getSetting('discord_redirect_uri') || `${req.protocol}://${req.get('host')}/auth/discord/callback`;
  if (!clientId || !clientSecret) return res.redirect('/?error=not_configured');
  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
    });
    const token = await tokenRes.json();
    if (!token.access_token) return res.redirect('/?error=token_failed');

    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    const user = await userRes.json();

    // Vérification appartenance au serveur Discord (si configuré)
    const requiredGuildId = getSetting('discord_guild_id');
    if (requiredGuildId) {
      const guildsRes = await fetch('https://discord.com/api/users/@me/guilds', {
        headers: { Authorization: `Bearer ${token.access_token}` },
      });
      const guilds = await guildsRes.json();
      if (!Array.isArray(guilds) || !guilds.some(g => g.id === requiredGuildId)) {
        return res.redirect('/?error=not_in_guild');
      }
    }

    // Pseudo affiché : surnom du serveur > display name global > username
    let displayName = user.global_name || user.username;
    const guildId   = getSetting('discord_guild_id');
    const botToken  = getSetting('discord_bot_token');
    if (guildId && botToken) {
      try {
        const memberRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${user.id}`, {
          headers: { Authorization: `Bot ${botToken}` },
        });
        if (memberRes.ok) {
          const member = await memberRes.json();
          if (member.nick) displayName = member.nick;
        }
      } catch (_) {}
    }

    const existing = db.prepare('SELECT id FROM users WHERE discord_id=?').get(user.id);
    let userId;
    if (existing) {
      db.prepare('UPDATE users SET username=?, avatar=? WHERE discord_id=?').run(displayName, user.avatar, user.id);
      userId = existing.id;
    } else {
      const r = db.prepare('INSERT INTO users (discord_id, username, avatar) VALUES (?,?,?)').run(user.id, displayName, user.avatar);
      userId = r.lastInsertRowid;
    }
    req.session.userId = userId;
    req.session.save(() => res.redirect('/'));
  } catch (e) {
    console.error('Discord OAuth error:', e);
    res.redirect('/?error=oauth_failed');
  }
});

app.get('/auth/me', (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Non authentifié' });
  const user = db.prepare('SELECT id, username, avatar, discord_id, is_admin FROM users WHERE id=?').get(req.session.userId);
  if (!user) return res.status(401).json({ error: 'Utilisateur introuvable' });
  res.json(user);
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// ── Middlewares ───────────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (req.session?.userId) return next();
  res.status(401).json({ error: 'Non authentifié' });
}

function requireAdmin(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Non authentifié' });
  const user = db.prepare('SELECT is_admin FROM users WHERE id=?').get(req.session.userId);
  if (!user?.is_admin) return res.status(403).json({ error: 'Accès admin requis' });
  next();
}

app.use('/api', requireAuth);

// ── Merchandise ──────────────────────────────────────────────────────────────

app.get('/api/merchandise', (_, res) =>
  res.json(db.prepare('SELECT * FROM merchandise ORDER BY name').all())
);

app.post('/api/merchandise', requireAdmin, (req, res) => {
  const { name, grow_time_minutes, grow_time_interior, color = '#4CAF50' } = req.body;
  const interior = grow_time_interior ?? grow_time_minutes;
  const r = db.prepare('INSERT INTO merchandise (name, grow_time_minutes, grow_time_interior, color) VALUES (?, ?, ?, ?)')
    .run(name, grow_time_minutes, interior, color);
  res.json({ id: r.lastInsertRowid, name, grow_time_minutes, grow_time_interior: interior, color });
});

app.put('/api/merchandise/:id', requireAdmin, (req, res) => {
  const { name, grow_time_minutes, grow_time_interior, color } = req.body;
  const interior = grow_time_interior ?? grow_time_minutes;
  db.prepare('UPDATE merchandise SET name=?, grow_time_minutes=?, grow_time_interior=?, color=? WHERE id=?')
    .run(name, grow_time_minutes, interior, color, req.params.id);
  res.json({ success: true });
});

app.delete('/api/merchandise/:id', requireAdmin, (req, res) => {
  const hasActive = db.prepare("SELECT id FROM points WHERE merchandise_id=? AND status!='harvested'").get(req.params.id);
  if (hasActive) return res.status(400).json({ error: 'Cette marchandise a des plants actifs — récoltez-les d\'abord' });
  db.prepare('DELETE FROM merchandise WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ── Points ───────────────────────────────────────────────────────────────────

app.get('/api/points', (req, res) => {
  db.prepare(`
    UPDATE points SET status='ready'
    WHERE status='growing'
    AND CAST((julianday('now') - julianday(planted_at)) * 24 * 60 AS INTEGER) >= (
      SELECT CASE WHEN points.environment = 'interior' THEN m.grow_time_interior ELSE m.grow_time_minutes END
      FROM merchandise m WHERE m.id = merchandise_id
    )
  `).run();

  const userId = req.session.userId;
  const points = db.prepare(`
    SELECT p.*,
           m.name AS merchandise_name,
           m.grow_time_minutes,
           m.grow_time_interior,
           m.color,
           CASE WHEN p.environment = 'interior' THEN m.grow_time_interior ELSE m.grow_time_minutes END AS effective_grow_time,
           CAST((julianday('now') - julianday(p.planted_at)) * 24 * 60 AS INTEGER) AS elapsed_minutes,
           u.username AS player_name,
           u.discord_id AS player_discord_id,
           u.avatar AS player_avatar
    FROM points p
    JOIN merchandise m ON p.merchandise_id = m.id
    LEFT JOIN users u ON p.user_id = u.id
    WHERE p.status != 'harvested'
      AND (p.visibility = 'shared' OR p.visibility IS NULL OR p.user_id = ?)
    ORDER BY p.planted_at DESC
  `).all(userId);
  res.json(points);
});

app.post('/api/points', (req, res) => {
  const { merchandise_id, lat = 0, lng = 0, position_type, quantity = 1, environment = 'exterior', elapsed_minutes = 0, notes = '', location_name = '', visibility = 'shared', on_map = 1 } = req.body;
  if (!['ground', 'elevated'].includes(position_type)) return res.status(400).json({ error: 'Position invalide' });
  if (!['shared', 'personal'].includes(visibility))    return res.status(400).json({ error: 'Visibilité invalide' });
  const planted_at = new Date(Date.now() - elapsed_minutes * 60000).toISOString();
  const r = db.prepare(
    'INSERT INTO points (merchandise_id, lat, lng, position_type, quantity, environment, planted_at, notes, user_id, location_name, visibility, on_map) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(merchandise_id, lat, lng, position_type, quantity, environment, planted_at, notes, req.session.userId, location_name, visibility, on_map);
  broadcast('points:changed', {});
  res.json({ id: r.lastInsertRowid, planted_at });
});

// Helper : vérifie qu'on est admin ou propriétaire du point
function requirePointAccess(req, res, pointId) {
  const point = db.prepare('SELECT user_id, visibility FROM points WHERE id=?').get(pointId);
  if (!point) { res.status(404).json({ error: 'Introuvable' }); return null; }
  const user = db.prepare('SELECT is_admin FROM users WHERE id=?').get(req.session.userId);
  if (user?.is_admin || point.user_id === req.session.userId) return point;
  res.status(403).json({ error: 'Non autorisé' });
  return null;
}

app.put('/api/points/:id', (req, res) => {
  if (!requirePointAccess(req, res, req.params.id)) return;
  const { merchandise_id, position_type, quantity, environment, elapsed_minutes, notes, location_name = '' } = req.body;
  const planted_at = new Date(Date.now() - elapsed_minutes * 60000).toISOString();
  const { visibility } = req.body;
  // Ne pas réinitialiser notified si le plant est déjà mature (évite double notification)
  const merch = db.prepare('SELECT grow_time_minutes, grow_time_interior FROM merchandise WHERE id=?').get(merchandise_id);
  const growTime = environment === 'interior' ? (merch?.grow_time_interior ?? merch?.grow_time_minutes) : merch?.grow_time_minutes;
  const alreadyMature = growTime && Number(elapsed_minutes) >= Number(growTime) ? 1 : 0;
  db.prepare(`
    UPDATE points
    SET merchandise_id=?, position_type=?, quantity=?, environment=?, planted_at=?, notes=?, location_name=?, visibility=?,
        status='growing', notified=CASE WHEN ? THEN notified ELSE 0 END,
        user_id=COALESCE(user_id, ?)
    WHERE id=?
  `).run(merchandise_id, position_type, quantity, environment, planted_at, notes, location_name, visibility || 'shared', alreadyMature, req.session.userId, req.params.id);
  broadcast('points:changed', {});
  res.json({ success: true });
});

app.put('/api/points/:id/harvest', (req, res) => {
  const point = db.prepare('SELECT user_id, visibility FROM points WHERE id=?').get(req.params.id);
  if (!point) return res.status(404).json({ error: 'Introuvable' });
  const user = db.prepare('SELECT is_admin FROM users WHERE id=?').get(req.session.userId);
  // Admin, propriétaire, ou plant partagé (toute l'équipe peut récolter)
  if (!user?.is_admin && point.user_id !== req.session.userId && point.visibility !== 'shared') {
    return res.status(403).json({ error: 'Non autorisé' });
  }
  const pointData = db.prepare(`
    SELECT p.*, m.name AS merchandise_name, m.color AS merchandise_color
    FROM points p JOIN merchandise m ON p.merchandise_id = m.id WHERE p.id=?
  `).get(req.params.id);
  db.prepare("UPDATE points SET status='harvested' WHERE id=?").run(req.params.id);
  if (pointData) {
    db.prepare(`
      INSERT INTO harvest_log (point_id, merchandise_id, merchandise_name, merchandise_color, quantity, user_id, visibility, location_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(pointData.id, pointData.merchandise_id, pointData.merchandise_name, pointData.merchandise_color,
           pointData.quantity, req.session.userId, pointData.visibility || 'shared', pointData.location_name || '');
  }
  broadcast('points:changed', {});
  res.json({ success: true });
});

app.delete('/api/points/:id', (req, res) => {
  if (!requirePointAccess(req, res, req.params.id)) return;
  db.prepare('DELETE FROM points WHERE id=?').run(req.params.id);
  broadcast('points:changed', {});
  res.json({ success: true });
});

// ── Helpers sessions ──────────────────────────────────────────────────────────

function revokeDiscordSessions(currentSid) {
  // Récupère toutes les sessions sauf la courante, supprime celles des users non-admin
  const sessions = db.prepare('SELECT sid, sess FROM sessions WHERE sid != ?').all(currentSid);
  let count = 0;
  for (const s of sessions) {
    try {
      const data   = JSON.parse(s.sess);
      const userId = data.userId;
      if (!userId) { db.prepare('DELETE FROM sessions WHERE sid=?').run(s.sid); count++; continue; }
      const user = db.prepare('SELECT is_admin FROM users WHERE id=?').get(userId);
      if (!user?.is_admin) { db.prepare('DELETE FROM sessions WHERE sid=?').run(s.sid); count++; }
    } catch (_) { db.prepare('DELETE FROM sessions WHERE sid=?').run(s.sid); count++; }
  }
  return count;
}

// ── Settings (admin seulement) ────────────────────────────────────────────────

app.get('/api/settings', requireAdmin, (_, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const obj = {};
  rows.forEach(r => { obj[r.key] = r.value; });
  delete obj.admin_password_hash;
  if (obj.discord_client_secret) obj.discord_client_secret = '***';
  if (obj.discord_bot_token)     obj.discord_bot_token     = '***';
  res.json(obj);
});

app.put('/api/settings', requireAdmin, (req, res) => {
  const guildChanged = 'discord_guild_id' in req.body;
  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  const run = db.transaction(() => {
    Object.entries(req.body).forEach(([k, v]) => {
      if (k === 'admin_password_hash') return;
      if (k === 'discord_client_secret' && v === '***') return;
      if (k === 'discord_bot_token'     && v === '***') return;
      upsert.run(k, v);
    });
  });
  run();
  // Si le guild ID change, purger toutes les sessions non-admin
  if (guildChanged) revokeDiscordSessions(req.sessionID);
  res.json({ success: true });
});

// Révoquer toutes les sessions Discord (hors session admin courante)
app.post('/api/admin/revoke-sessions', requireAdmin, (req, res) => {
  const count = revokeDiscordSessions(req.sessionID);
  res.json({ success: true, revoked: count });
});

app.post('/api/settings/test-bot', requireAdmin, async (_, res) => {
  const token     = getSetting('discord_bot_token');
  const channelId = getSetting('discord_notify_channel_id');
  if (!token)     return res.status(400).json({ error: 'Aucun bot token configuré' });
  if (!channelId) return res.status(400).json({ error: 'Aucun salon configuré' });
  try {
    const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bot ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [{ title: '🧪 Test — GTA V Drug Map', description: 'Le bot fonctionne !', color: 0x3fb950 }] }),
    });
    if (!r.ok) { const e = await r.json(); return res.status(502).json({ error: e.message || `Discord ${r.status}` }); }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Changer le mot de passe admin
app.post('/api/admin/password', requireAdmin, (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) return res.status(400).json({ error: 'Mot de passe trop court (min. 6 caractères)' });
  setSetting('admin_password_hash', hashPassword(password));
  res.json({ success: true });
});

// ── Helpers Discord ───────────────────────────────────────────────────────────

async function botPost(path, body, token) {
  return fetch(`https://discord.com/api/v10${path}`, {
    method: 'POST',
    headers: { 'Authorization': `Bot ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function botPatch(path, body, token) {
  return fetch(`https://discord.com/api/v10${path}`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bot ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Édite le message Discord d'une commande si on a son ID
function getOrderItemsStr(orderId) {
  const lines = db.prepare(`
    SELECT ol.quantity, oi.name FROM order_lines ol
    JOIN order_items oi ON ol.item_id = oi.id
    WHERE ol.order_id = ? ORDER BY ol.id
  `).all(orderId);
  return lines.map(l => `${l.name} ×${l.quantity}`).join('\n') || '—';
}

async function patchOrderMessage(orderId, token, channelId) {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if (!order?.discord_message_id || !channelId) return;

  const assignees = db.prepare(`
    SELECT u.username FROM order_assignments oa JOIN users u ON oa.user_id = u.id WHERE oa.order_id = ?
  `).all(orderId);
  const deadlineStr   = order.deadline ? new Date(order.deadline).toLocaleDateString('fr-FR') : 'Non définie';
  const assigneeNames = assignees.map(u => u.username).join(', ') || '—';
  const itemsStr      = getOrderItemsStr(orderId);

  const embed = buildOrderEmbed(orderId, itemsStr, order.status, assigneeNames, deadlineStr, order.client);
  try {
    await botPatch(`/channels/${channelId}/messages/${order.discord_message_id}`, embed, token);
  } catch (e) {
    console.error('patchOrderMessage error:', e.message);
  }
}

async function verifyDiscordSig(rawBody, signature, timestamp, publicKeyHex) {
  try {
    const key = await webcrypto.subtle.importKey(
      'raw', Buffer.from(publicKeyHex, 'hex'), { name: 'Ed25519' }, false, ['verify']
    );
    return await webcrypto.subtle.verify(
      'Ed25519', key,
      Buffer.from(signature, 'hex'),
      Buffer.concat([Buffer.from(timestamp), rawBody])
    );
  } catch { return false; }
}

function buildOrderEmbed(orderId, itemsStr, status, assigneeNames, deadlineStr, client) {
  const statusLabel = {
    pending:     '⏳ En attente',
    in_progress: '🔄 En cours',
    to_deliver:  '📦 À livrer',
    done:        '✅ Terminée',
  }[status] || '⏳ En attente';

  const color = {
    pending:     0x8b949e,
    in_progress: 0x79c0ff,
    to_deliver:  0xd2a8ff,
    done:        0x56d364,
  }[status] || 0x8b949e;

  const title = {
    pending:     '📋 Nouveau contrat',
    in_progress: '🔄 Contrat en cours',
    to_deliver:  '📦 Contrat à livrer',
    done:        '✅ Contrat terminé',
  }[status] || '📋 Contrat';

  const fields = [
    { name: 'Articles',  value: itemsStr,      inline: false },
    { name: 'Deadline',  value: deadlineStr,   inline: true },
    { name: 'Assigné à', value: assigneeNames, inline: true },
  ];
  if (client) fields.push({ name: 'Note', value: client, inline: true });
  fields.push({ name: 'Statut', value: statusLabel, inline: true });

  const embeds = [{ title, color, fields }];

  // Un seul bouton = l'étape suivante dans le workflow
  let nextButton = null;
  if (status === 'pending')     nextButton = { type: 2, style: 1, label: '🔄 En cours',    custom_id: `order_inprogress_${orderId}` };
  if (status === 'in_progress') nextButton = { type: 2, style: 1, label: '📦 À livrer',    custom_id: `order_to_deliver_${orderId}` };
  if (status === 'to_deliver')  nextButton = { type: 2, style: 3, label: '✅ Terminée',    custom_id: `order_done_${orderId}` };

  const components = nextButton ? [{ type: 1, components: [nextButton] }] : [];

  return { embeds, components };
}

// ── Discord Interactions (boutons dans les messages du bot) ───────────────────

app.post('/discord/interactions', async (req, res) => {
  const sig       = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];
  const publicKey = getSetting('discord_public_key');

  if (!sig || !timestamp || !req.rawBody) {
    console.error('[interactions] Headers manquants:', { sig: !!sig, timestamp: !!timestamp, rawBody: !!req.rawBody });
    return res.status(401).json({ error: 'Missing headers' });
  }

  if (!publicKey) {
    console.error('[interactions] discord_public_key non configurée dans les paramètres');
    return res.status(401).json({ error: 'Public key not configured' });
  }

  const valid = await verifyDiscordSig(req.rawBody, sig, timestamp, publicKey);
  if (!valid) {
    console.error('[interactions] Signature invalide');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const body = req.body;

  if (body.type === 1) return res.json({ type: 1 }); // PING

  if (body.type === 3) { // MESSAGE_COMPONENT (bouton)
    const customId = body.data?.custom_id || '';
    let orderId, newStatus;

    if (customId.startsWith('order_inprogress_')) {
      orderId   = parseInt(customId.replace('order_inprogress_', ''));
      newStatus = 'in_progress';
      db.prepare("UPDATE orders SET status='in_progress' WHERE id=? AND status='pending'").run(orderId);
    } else if (customId.startsWith('order_to_deliver_')) {
      orderId   = parseInt(customId.replace('order_to_deliver_', ''));
      newStatus = 'to_deliver';
      db.prepare("UPDATE orders SET status='to_deliver' WHERE id=? AND status='in_progress'").run(orderId);
    } else if (customId.startsWith('order_done_')) {
      orderId   = parseInt(customId.replace('order_done_', ''));
      newStatus = 'done';
      db.prepare("UPDATE orders SET status='done' WHERE id=?").run(orderId);
    } else {
      return res.json({ type: 1 });
    }

    const order     = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
    const assignees = db.prepare('SELECT u.username FROM order_assignments oa JOIN users u ON oa.user_id=u.id WHERE oa.order_id=?').all(orderId);
    const deadlineStr   = order?.deadline ? new Date(order.deadline).toLocaleDateString('fr-FR') : 'Non définie';
    const assigneeNames = assignees.map(u => u.username).join(', ') || '—';
    const itemsStr      = getOrderItemsStr(orderId);

    // Log event
    db.prepare("INSERT INTO order_events (order_id, event_type, new_status) VALUES (?, 'status_changed', ?)").run(orderId, newStatus);

    // Broadcast temps-réel vers le dashboard
    broadcast('orders:changed', {});

    return res.json({
      type: 7, // UPDATE_MESSAGE
      data: buildOrderEmbed(orderId, itemsStr, newStatus, assigneeNames, deadlineStr, order?.client),
    });
  }

  res.json({ type: 1 });
});

async function getDmChannelId(discordId, token) {
  const r = await botPost('/users/@me/channels', { recipient_id: discordId }, token);
  if (!r.ok) return null;
  const data = await r.json();
  return data.id || null;
}

setInterval(async () => {
  const token = getSetting('discord_bot_token');
  if (!token) return;

  const notifyChannelId = getSetting('discord_notify_channel_id');

  const ready = db.prepare(`
    SELECT p.*, m.name AS merchandise_name, u.username AS player_name, u.discord_id AS player_discord_id,
           COALESCE(u.discord_notify, 1) AS discord_notify
    FROM points p
    JOIN merchandise m ON p.merchandise_id = m.id
    LEFT JOIN users u ON p.user_id = u.id
    WHERE p.status='ready' AND p.notified=0
  `).all();

  for (const p of ready) {
    try {
      const fields = [
        { name: 'Joueur',        value: p.player_name || 'Inconnu',                               inline: true },
        { name: 'Marchandise',   value: p.merchandise_name,                                       inline: true },
        { name: 'Quartier',      value: p.location_name || 'Inconnu',                             inline: true },
        { name: 'Quantité',      value: `${p.quantity} plant${p.quantity > 1 ? 's' : ''}`,        inline: true },
        { name: 'Position',      value: p.position_type === 'ground' ? 'Au sol' : 'En hauteur',   inline: true },
        { name: 'Environnement', value: p.environment === 'interior' ? 'Intérieur' : 'Extérieur', inline: true },
      ];

      let sent = false;

      if (p.visibility === 'personal') {
        // MP au propriétaire si c'est un vrai compte Discord et que les notifs sont activées
        const discordId = p.player_discord_id;
        const isRealUser = discordId && discordId !== '__admin__' && discordId !== 'local';
        if (!isRealUser || !p.discord_notify) {
          // Pas de compte Discord ou notifs désactivées
          db.prepare('UPDATE points SET notified=1 WHERE id=?').run(p.id);
          continue;
        }
        const dmId = await getDmChannelId(discordId, token);
        if (dmId) {
          const r = await botPost(`/channels/${dmId}/messages`, {
            embeds: [{ title: '🔒 Ta plantation est prête à récolter !', color: 0x9c27b0, fields }],
          }, token);
          if (r.ok) sent = true;
        }
      } else if (notifyChannelId) {
        // Notification dans le salon pour les plantations partagées
        const r = await botPost(`/channels/${notifyChannelId}/messages`, {
          embeds: [{ title: '🌿 Plantation prête à récolter !', color: 0x3fb950, fields }],
        }, token);
        if (r.ok) sent = true;
      }

      if (sent) db.prepare('UPDATE points SET notified=1 WHERE id=?').run(p.id);
    } catch (e) {
      console.error('Bot notification error:', e.message);
    }
  }
}, 60_000);

// ── Stats ─────────────────────────────────────────────────────────────────────

app.get('/api/stats', requireAuth, (_, res) => {
  // KPIs ventes
  const totals = db.prepare(`
    SELECT
      COUNT(DISTINCT ol.order_id)       AS nb_contracts,
      SUM(ol.quantity)                  AS total_units,
      SUM(ol.sale_price)                AS total_revenue
    FROM order_lines ol
    WHERE ol.status = 'done' AND ol.sale_price > 0
  `).get();

  // Classement membres par revenu (contrats où ils sont assignés)
  const byMember = db.prepare(`
    SELECT u.id, u.username, u.avatar, u.discord_id,
      COUNT(DISTINCT oa.order_id)                        AS nb_contracts,
      SUM(ol.quantity)                                   AS total_units,
      SUM(ol.sale_price)                                 AS total_revenue
    FROM order_assignments oa
    JOIN users u ON oa.user_id = u.id
    JOIN order_lines ol ON ol.order_id = oa.order_id
    WHERE ol.status = 'done' AND ol.sale_price > 0
    GROUP BY u.id
    ORDER BY total_revenue DESC
    LIMIT 10
  `).all();

  res.json({ totals, byMember });
});

// ── Recettes ──────────────────────────────────────────────────────────────────


app.get('/api/stats/sales', requireAuth, (_, res) => {
  const rows = db.prepare(`
    SELECT oi.id, oi.name, oi.category,
      SUM(ol.quantity)    AS total_qty,
      SUM(ol.sale_price)  AS total_revenue,
      COUNT(*)            AS nb_lines,
      ROUND(CAST(SUM(ol.sale_price) AS REAL) / NULLIF(SUM(ol.quantity), 0), 0) AS avg_price_per_unit,
      ROUND(CAST(MIN(ol.sale_price) AS REAL) / NULLIF(ol.quantity, 0), 0)       AS min_price_per_unit,
      ROUND(CAST(MAX(ol.sale_price) AS REAL) / NULLIF(ol.quantity, 0), 0)       AS max_price_per_unit
    FROM order_lines ol
    JOIN order_items oi ON ol.item_id = oi.id
    WHERE ol.status = 'done' AND ol.sale_price IS NOT NULL AND ol.sale_price > 0
    GROUP BY ol.item_id
    ORDER BY total_revenue DESC
  `).all();
  res.json(rows);
});

app.get('/api/recipes', (_, res) => {
  const products = db.prepare(`
    SELECT oi.id, oi.name, oi.category
    FROM order_items oi
    WHERE EXISTS (SELECT 1 FROM recipes r WHERE r.product_id = oi.id)
    ORDER BY oi.category, oi.name
  `).all();

  for (const p of products) {
    p.ingredients = db.prepare(`
      SELECT i.id, i.name, r.quantity,
             COALESCE(inv.quantity, 0) AS stock
      FROM recipes r
      JOIN order_items i ON r.ingredient_id = i.id
      LEFT JOIN inventory inv ON inv.item_id = i.id
      WHERE r.product_id = ?
      ORDER BY i.name
    `).all(p.id);
  }

  res.json(products);
});

// ── Inventaire ────────────────────────────────────────────────────────────────

app.get('/api/inventory', (_, res) => {
  const items = db.prepare(`
    SELECT oi.id, oi.name, oi.category, oi.location,
           COALESCE(SUM(s.quantity), 0) AS total_quantity
    FROM order_items oi
    LEFT JOIN inventory_stock s ON s.item_id = oi.id
    GROUP BY oi.id
    ORDER BY oi.category, oi.name
  `).all();

  const stocks = db.prepare(`
    SELECT s.item_id, s.user_id, s.quantity, s.updated_at, u.username,
           ub.username AS updated_by_name
    FROM inventory_stock s
    JOIN users u ON s.user_id = u.id
    LEFT JOIN users ub ON s.updated_by = ub.id
    ORDER BY u.username
  `).all();

  const stockMap = {};
  for (const s of stocks) {
    if (!stockMap[s.item_id]) stockMap[s.item_id] = [];
    stockMap[s.item_id].push(s);
  }

  res.json(items.map(item => ({ ...item, stocks: stockMap[item.id] || [] })));
});

app.put('/api/inventory/:itemId', (req, res) => {
  const { delta } = req.body;
  if (typeof delta !== 'number') return res.status(400).json({ error: 'delta requis' });
  const item = db.prepare('SELECT id FROM order_items WHERE id=?').get(req.params.itemId);
  if (!item) return res.status(404).json({ error: 'Article introuvable' });

  const current = db.prepare('SELECT quantity FROM inventory_stock WHERE item_id=? AND user_id=?')
    .get(req.params.itemId, req.session.userId);
  const newQty = Math.max(0, (current?.quantity || 0) + delta);

  db.prepare(`
    INSERT INTO inventory_stock (item_id, user_id, quantity, updated_at, updated_by)
    VALUES (?, ?, ?, datetime('now'), ?)
    ON CONFLICT(item_id, user_id) DO UPDATE SET
      quantity   = excluded.quantity,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by
  `).run(req.params.itemId, req.session.userId, newQty, req.session.userId);

  db.prepare(`
    INSERT INTO stock_movements (item_id, user_id, delta, qty_after, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(req.params.itemId, req.session.userId, delta, newQty);

  broadcast('inventory:changed', {});
  res.json({ quantity: newQty });
});

// ── Users list (pour assignation des commandes) ───────────────────────────────
app.get('/api/users', (_, res) => {
  res.json(db.prepare('SELECT id, username, avatar, discord_id, discord_notify, is_admin FROM users ORDER BY username').all());
});

app.patch('/api/users/me/notify', (req, res) => {
  const { discord_notify } = req.body;
  db.prepare('UPDATE users SET discord_notify=? WHERE id=?').run(discord_notify ? 1 : 0, req.session.userId);
  res.json({ success: true, discord_notify: discord_notify ? 1 : 0 });
});

// ── Favoris inventaire ────────────────────────────────────────────────────────

app.get('/api/inventory/favorites', (req, res) => {
  const rows = db.prepare('SELECT item_id FROM inventory_favorites WHERE user_id=? ORDER BY rowid ASC').all(req.session.userId);
  res.json(rows.map(r => r.item_id));
});

app.post('/api/inventory/favorites/:itemId', (req, res) => {
  db.prepare('INSERT OR IGNORE INTO inventory_favorites (user_id, item_id) VALUES (?, ?)').run(req.session.userId, req.params.itemId);
  res.json({ success: true });
});

app.delete('/api/inventory/favorites/:itemId', (req, res) => {
  db.prepare('DELETE FROM inventory_favorites WHERE user_id=? AND item_id=?').run(req.session.userId, req.params.itemId);
  res.json({ success: true });
});

// ── Attribution stock par membre (set direct, pas delta) ─────────────────────

app.put('/api/inventory/:itemId/stocks', (req, res) => {
  const { stocks } = req.body;
  if (!Array.isArray(stocks)) return res.status(400).json({ error: 'stocks requis' });
  const item = db.prepare('SELECT id FROM order_items WHERE id=?').get(req.params.itemId);
  if (!item) return res.status(404).json({ error: 'Article introuvable' });

  const upsert     = db.prepare(`
    INSERT INTO inventory_stock (item_id, user_id, quantity, updated_at, updated_by)
    VALUES (?, ?, ?, datetime('now'), ?)
    ON CONFLICT(item_id, user_id) DO UPDATE SET quantity=excluded.quantity, updated_at=excluded.updated_at, updated_by=excluded.updated_by
  `);
  const getOld     = db.prepare('SELECT quantity FROM inventory_stock WHERE item_id=? AND user_id=?');
  const insMov     = db.prepare(`INSERT INTO stock_movements (item_id, user_id, delta, qty_after, created_at) VALUES (?, ?, ?, ?, datetime('now'))`);

  db.transaction(() => {
    for (const { user_id, quantity } of stocks) {
      const qty   = Math.max(0, parseInt(quantity) || 0);
      const old   = getOld.get(req.params.itemId, user_id);
      const delta = qty - (old?.quantity || 0);
      if (delta !== 0) insMov.run(req.params.itemId, user_id, delta, qty);
      upsert.run(req.params.itemId, user_id, qty, req.session.userId);
    }
  })();

  broadcast('inventory:changed', {});
  res.json({ success: true });
});

// ── Mouvements de stock ───────────────────────────────────────────────────────

app.get('/api/inventory/:itemId/movements', (req, res) => {
  const movements = db.prepare(`
    SELECT sm.*, u.username AS user_name
    FROM stock_movements sm
    LEFT JOIN users u ON sm.user_id = u.id
    WHERE sm.item_id = ?
    ORDER BY sm.created_at DESC
    LIMIT 50
  `).all(req.params.itemId);
  res.json(movements);
});

// ── Order items ───────────────────────────────────────────────────────────────
app.get('/api/order-items', (_, res) => {
  res.json(db.prepare('SELECT * FROM order_items WHERE orderable = 1 OR orderable IS NULL ORDER BY name').all());
});

app.post('/api/order-items', requireAdmin, (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Nom requis' });
  try {
    const r = db.prepare('INSERT INTO order_items (name) VALUES (?)').run(name.trim());
    res.json({ id: r.lastInsertRowid, name: name.trim() });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'Cet article existe déjà' });
    throw e;
  }
});

app.put('/api/order-items/:id', requireAdmin, (req, res) => {
  const { name, location } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Nom requis' });
  try {
    db.prepare('UPDATE order_items SET name=?, location=? WHERE id=?').run(name.trim(), location || null, req.params.id);
    res.json({ success: true });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'Cet article existe déjà' });
    throw e;
  }
});

app.delete('/api/order-items/:id', requireAdmin, (req, res) => {
  const hasActive = db.prepare("SELECT id FROM orders WHERE item_id=? AND status='pending'").get(req.params.id);
  if (hasActive) return res.status(400).json({ error: 'Des commandes actives utilisent cet article' });
  db.prepare('DELETE FROM order_items WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ── Orders ────────────────────────────────────────────────────────────────────
app.get('/api/orders', (_, res) => {
  const orders = db.prepare(`
    SELECT o.*,
           u.username AS created_by_name,
           COALESCE(u.is_admin, 0) AS created_by_is_admin
    FROM orders o
    LEFT JOIN users u ON o.created_by = u.id
    ORDER BY o.created_at DESC
  `).all();
  const linesStmt = db.prepare(`
    SELECT ol.id, ol.item_id, ol.quantity, ol.status, ol.sale_price, oi.name AS item_name
    FROM order_lines ol JOIN order_items oi ON ol.item_id = oi.id
    WHERE ol.order_id = ? ORDER BY ol.id
  `);
  const assignStmt = db.prepare(`
    SELECT u.id, u.username, u.avatar, u.discord_id
    FROM order_assignments oa JOIN users u ON oa.user_id = u.id
    WHERE oa.order_id = ?
  `);
  for (const o of orders) {
    o.lines     = linesStmt.all(o.id);
    o.assignees = assignStmt.all(o.id);
  }
  res.json(orders);
});

app.get('/api/orders/:id/events', (req, res) => {
  const events = db.prepare(`
    SELECT oe.*, u.username AS user_name
    FROM order_events oe
    LEFT JOIN users u ON oe.user_id = u.id
    WHERE oe.order_id = ?
    ORDER BY oe.created_at ASC
  `).all(req.params.id);
  res.json(events);
});

app.post('/api/orders', async (req, res) => {
  const { lines = [], deadline, user_ids = [], client } = req.body;
  const validLines = (Array.isArray(lines) ? lines : []).filter(l => l.item_id && parseInt(l.item_id));
  if (validLines.length === 0) return res.status(400).json({ error: 'Au moins 1 article requis' });
  if (validLines.length > 5)   return res.status(400).json({ error: '5 articles maximum' });
  if (!Array.isArray(user_ids) || user_ids.length === 0)
    return res.status(400).json({ error: 'Assigne le contrat à au moins une personne' });

  const r = db.prepare('INSERT INTO orders (deadline, created_by, client) VALUES (?, ?, ?)')
    .run(deadline || null, req.session.userId, client || null);
  const orderId = r.lastInsertRowid;

  const insLine   = db.prepare('INSERT INTO order_lines (order_id, item_id, quantity, status, sale_price) VALUES (?, ?, ?, ?, ?)');
  const insAssign = db.prepare('INSERT OR IGNORE INTO order_assignments (order_id, user_id) VALUES (?, ?)');
  for (const { item_id, quantity, status: ls = 'pending', sale_price: lp = null } of validLines)
    insLine.run(orderId, parseInt(item_id), Math.max(1, parseInt(quantity) || 1), ls, lp != null ? parseInt(lp) : null);
  for (const uid of user_ids) insAssign.run(orderId, uid);

  // Log création
  db.prepare("INSERT INTO order_events (order_id, event_type, new_status, user_id) VALUES (?, 'created', 'pending', ?)")
    .run(orderId, req.session.userId);

  // Notification Discord
  const token     = getSetting('discord_bot_token');
  const channelId = getSetting('discord_orders_channel_id') || getSetting('discord_notify_channel_id');
  if (token && channelId) {
    try {
      const assignees = db.prepare(`
        SELECT u.username, u.discord_id, COALESCE(u.discord_notify, 1) AS discord_notify
        FROM order_assignments oa JOIN users u ON oa.user_id = u.id WHERE oa.order_id = ?
      `).all(orderId);
      const mentions      = assignees.filter(u => u.discord_id && u.discord_id !== '__admin__' && u.discord_id !== 'local' && u.discord_notify).map(u => `<@${u.discord_id}>`).join(' ');
      const deadlineStr   = deadline ? new Date(deadline).toLocaleDateString('fr-FR') : 'Non définie';
      const assigneeNames = assignees.map(u => u.username).join(', ') || '—';
      const itemsStr      = getOrderItemsStr(orderId);
      const embed = buildOrderEmbed(orderId, itemsStr, 'pending', assigneeNames, deadlineStr, client);
      const msgRes = await botPost(`/channels/${channelId}/messages`, { content: mentions || null, ...embed }, token);
      if (msgRes.ok) {
        const msgData = await msgRes.json();
        if (msgData.id) db.prepare('UPDATE orders SET discord_message_id=? WHERE id=?').run(msgData.id, orderId);
      }
    } catch (e) { console.error('Order notification error:', e.message); }
  }

  broadcast('orders:changed', {});
  res.json({ id: orderId });
});

app.put('/api/orders/:id', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Introuvable' });
  const user = db.prepare('SELECT is_admin FROM users WHERE id=?').get(req.session.userId);
  // Commandes admin : réservées aux admins. Commandes user : tout le monde peut modifier.
  const creator = order.created_by ? db.prepare('SELECT is_admin FROM users WHERE id=?').get(order.created_by) : null;
  if (creator?.is_admin && !user?.is_admin)
    return res.status(403).json({ error: 'Seul un admin peut modifier cette commande' });

  const { lines, deadline, user_ids, status, client, sale_price } = req.body;
  const validStatuses = ['pending', 'in_progress', 'to_deliver', 'done'];
  const newStatus = validStatuses.includes(status) ? status : order.status;
  const newSalePrice = newStatus === 'done' && sale_price != null ? (parseInt(sale_price) || null) : (newStatus !== 'done' ? null : order.sale_price);
  db.prepare('UPDATE orders SET deadline=?, status=?, client=?, sale_price=? WHERE id=?')
    .run(deadline || null, newStatus, client || null, newSalePrice, req.params.id);

  if (Array.isArray(lines)) {
    const validLines = lines.filter(l => l.item_id && parseInt(l.item_id)).slice(0, 5);
    // Sauvegarder les anciens statuts par item_id avant suppression
    const oldLines = db.prepare('SELECT item_id, status FROM order_lines WHERE order_id=?').all(req.params.id);
    const oldStatusMap = {};
    for (const ol of oldLines) oldStatusMap[ol.item_id] = ol.status;
    db.prepare('DELETE FROM order_lines WHERE order_id=?').run(req.params.id);
    const insLine = db.prepare('INSERT INTO order_lines (order_id, item_id, quantity, status, sale_price) VALUES (?, ?, ?, ?, ?)');
    for (const { item_id, quantity, status: ls = 'pending', sale_price: lp = null } of validLines) {
      insLine.run(req.params.id, parseInt(item_id), Math.max(1, parseInt(quantity) || 1), ls, lp != null ? parseInt(lp) : null);
      // Log si statut de la ligne a changé
      const prevStatus = oldStatusMap[parseInt(item_id)];
      if (prevStatus !== undefined && prevStatus !== ls) {
        const itemName = db.prepare('SELECT name FROM order_items WHERE id=?').get(parseInt(item_id))?.name || `#${item_id}`;
        db.prepare("INSERT INTO order_events (order_id, event_type, new_status, user_id) VALUES (?, 'line_status_changed', ?, ?)")
          .run(req.params.id, `${itemName}: ${ls}`, req.session.userId);
      }
    }
  }
  if (Array.isArray(user_ids)) {
    db.prepare('DELETE FROM order_assignments WHERE order_id=?').run(req.params.id);
    const ins = db.prepare('INSERT OR IGNORE INTO order_assignments (order_id, user_id) VALUES (?, ?)');
    for (const uid of user_ids) ins.run(req.params.id, uid);
  }
  // Log changement de statut global si nécessaire
  if (newStatus !== order.status) {
    db.prepare("INSERT INTO order_events (order_id, event_type, new_status, user_id) VALUES (?, 'status_changed', ?, ?)")
      .run(req.params.id, newStatus, req.session.userId);
  }
  broadcast('orders:changed', {});

  // Patch du message Discord si le statut a changé
  const token     = getSetting('discord_bot_token');
  const channelId = getSetting('discord_orders_channel_id') || getSetting('discord_notify_channel_id');
  if (token && channelId && newStatus !== order.status && getSetting('discord_notif_enabled') !== '0') {
    if (discordNotifEnabled()) patchOrderMessage(req.params.id, token, channelId).catch(() => {});
  }

  res.json({ success: true });
});

// Changement de statut — accessible à tous les membres authentifiés
app.patch('/api/orders/:id/status', async (req, res) => {
  const { status, sale_price } = req.body;
  const validStatuses = ['pending', 'in_progress', 'to_deliver', 'done'];
  if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Statut invalide' });

  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Introuvable' });

  if (status === 'done' && sale_price != null) {
    db.prepare('UPDATE orders SET status=?, sale_price=? WHERE id=?').run(status, parseInt(sale_price) || null, req.params.id);
  } else {
    db.prepare('UPDATE orders SET status=? WHERE id=?').run(status, req.params.id);
  }
  db.prepare("INSERT INTO order_events (order_id, event_type, new_status, user_id) VALUES (?, 'status_changed', ?, ?)")
    .run(req.params.id, status, req.session.userId);
  broadcast('orders:changed', {});

  // Patch message Discord
  const token     = getSetting('discord_bot_token');
  const channelId = getSetting('discord_orders_channel_id') || getSetting('discord_notify_channel_id');
  if (token && channelId && order.discord_message_id) {
    if (discordNotifEnabled()) patchOrderMessage(req.params.id, token, channelId).catch(() => {});
  }

  res.json({ success: true });
});

app.post('/api/orders/:id/progress', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Introuvable' });
  db.prepare("UPDATE orders SET status='in_progress' WHERE id=? AND status='pending'").run(req.params.id);
  broadcast('orders:changed', {});
  res.json({ success: true });
});

app.post('/api/orders/:id/complete', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Introuvable' });
  const user = db.prepare('SELECT is_admin FROM users WHERE id=?').get(req.session.userId);
  if (!user?.is_admin && order.created_by !== req.session.userId)
    return res.status(403).json({ error: 'Non autorisé' });
  db.prepare("UPDATE orders SET status='done' WHERE id=?").run(req.params.id);
  broadcast('orders:changed', {});
  res.json({ success: true });
});

app.delete('/api/orders/:id', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Introuvable' });
  db.prepare('DELETE FROM orders WHERE id=?').run(req.params.id);
  broadcast('orders:changed', {});
  res.json({ success: true });
});

// ── Fin des routes ────────────────────────────────────────────────────────────

// (ancien onglet Contrats supprimé — remplacé par multi-lignes sur les ordres)
if (false) app.get('/api/contracts', (_, res) => {
  const contracts = db.prepare(`
    SELECT c.*, u.username AS created_by_name,
           (SELECT COUNT(*) FROM contract_lines WHERE contract_id = c.id) AS line_count,
           (SELECT COALESCE(SUM(qty_ordered * unit_price), 0) FROM contract_lines WHERE contract_id = c.id) AS total_value,
           (SELECT COALESCE(SUM(qty_delivered * unit_price), 0) FROM contract_lines WHERE contract_id = c.id) AS delivered_value
    FROM contracts c
    LEFT JOIN users u ON c.created_by = u.id
    ORDER BY c.created_at DESC
  `).all();
  res.json(contracts);
});

app.post('/api/contracts', (req, res) => {
  const { name, client, deadline, notes } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Nom requis' });
  const r = db.prepare(`
    INSERT INTO contracts (name, client, deadline, notes, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(name.trim(), client || null, deadline || null, notes || '', req.session.userId);
  broadcast('contracts:changed', {});
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/contracts/:id', (req, res) => {
  const { name, client, deadline, notes } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Nom requis' });
  db.prepare('UPDATE contracts SET name=?, client=?, deadline=?, notes=? WHERE id=?')
    .run(name.trim(), client || null, deadline || null, notes || '', req.params.id);
  broadcast('contracts:changed', {});
  res.json({ success: true });
});

app.delete('/api/contracts/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM contracts WHERE id=?').run(req.params.id);
  broadcast('contracts:changed', {});
  res.json({ success: true });
});

app.post('/api/contracts/:id/toggle-status', (req, res) => {
  const c = db.prepare('SELECT status FROM contracts WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Contrat introuvable' });
  const newStatus = c.status === 'closed' ? 'active' : 'closed';
  if (newStatus === 'closed') {
    db.prepare("UPDATE contracts SET status='closed', closed_at=datetime('now') WHERE id=?").run(req.params.id);
  } else {
    db.prepare("UPDATE contracts SET status='active', closed_at=NULL WHERE id=?").run(req.params.id);
  }
  broadcast('contracts:changed', {});
  res.json({ status: newStatus });
});

app.get('/api/contracts/:id/lines', (req, res) => {
  res.json(db.prepare('SELECT * FROM contract_lines WHERE contract_id=? ORDER BY id').all(req.params.id));
});

app.post('/api/contracts/:id/lines', (req, res) => {
  const { product_name, qty_ordered, unit_price } = req.body;
  if (!product_name?.trim()) return res.status(400).json({ error: 'Produit requis' });
  const r = db.prepare(`
    INSERT INTO contract_lines (contract_id, product_name, qty_ordered, unit_price)
    VALUES (?, ?, ?, ?)
  `).run(req.params.id, product_name.trim(), qty_ordered || 0, unit_price || 0);
  broadcast('contracts:changed', {});
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/contracts/:id/lines/:lid', (req, res) => {
  const { product_name, qty_ordered, qty_delivered, unit_price } = req.body;
  db.prepare(`
    UPDATE contract_lines SET product_name=?, qty_ordered=?, qty_delivered=?, unit_price=?
    WHERE id=? AND contract_id=?
  `).run(product_name, qty_ordered || 0, qty_delivered || 0, unit_price || 0, req.params.lid, req.params.id);
  broadcast('contracts:changed', {});
  res.json({ success: true });
});

app.delete('/api/contracts/:id/lines/:lid', (req, res) => {
  db.prepare('DELETE FROM contract_lines WHERE id=? AND contract_id=?').run(req.params.lid, req.params.id);
  broadcast('contracts:changed', {});
  res.json({ success: true });
});

app.get('/api/contracts/stats', (_, res) => {
  const rows = db.prepare(`
    SELECT cl.product_name,
           SUM(cl.qty_ordered)   AS total_ordered,
           SUM(cl.qty_delivered) AS total_delivered,
           SUM(cl.qty_delivered * cl.unit_price) AS total_revenue
    FROM contract_lines cl
    JOIN contracts c ON cl.contract_id = c.id
    GROUP BY cl.product_name
    ORDER BY total_revenue DESC
  `).all();
  res.json(rows);
});

server.listen(3000, () => console.log('GTA Dashboard → http://localhost:3000'));

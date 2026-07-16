const express = require('express');
const session = require('express-session');
const { scryptSync, randomBytes, timingSafeEqual } = require('crypto');
const db = require('./db');

const app = express();
app.use(express.json());

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
app.use(session({
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
}));

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

function getSetting(key) {
  return db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value ?? null;
}

function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)').run(key, value);
}

// ── Auth — routes publiques ───────────────────────────────────────────────────

// État de configuration (utilisé par le login screen)
app.get('/auth/config', (_, res) => {
  const adminExists     = !!getSetting('admin_password_hash');
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
  db.prepare("UPDATE points SET status='harvested' WHERE id=?").run(req.params.id);
  res.json({ success: true });
});

app.delete('/api/points/:id', (req, res) => {
  if (!requirePointAccess(req, res, req.params.id)) return;
  db.prepare('DELETE FROM points WHERE id=?').run(req.params.id);
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

// ── Notifications Discord bot (toutes les 60s) ────────────────────────────────

async function botPost(path, body, token) {
  return fetch(`https://discord.com/api/v10${path}`, {
    method: 'POST',
    headers: { 'Authorization': `Bot ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

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
    SELECT p.*, m.name AS merchandise_name, u.username AS player_name, u.discord_id AS player_discord_id
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
        // MP au propriétaire si c'est un vrai compte Discord
        const discordId = p.player_discord_id;
        const isRealUser = discordId && discordId !== '__admin__' && discordId !== 'local';
        if (!isRealUser) {
          // Pas de compte Discord → on marque quand même pour ne pas boucler indéfiniment
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

// ── Users list (pour assignation des commandes) ───────────────────────────────
app.get('/api/users', (_, res) => {
  res.json(db.prepare('SELECT id, username, avatar, discord_id FROM users ORDER BY username').all());
});

// ── Order items ───────────────────────────────────────────────────────────────
app.get('/api/order-items', (_, res) => {
  res.json(db.prepare('SELECT * FROM order_items ORDER BY name').all());
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

app.delete('/api/order-items/:id', requireAdmin, (req, res) => {
  const hasActive = db.prepare("SELECT id FROM orders WHERE item_id=? AND status='pending'").get(req.params.id);
  if (hasActive) return res.status(400).json({ error: 'Des commandes actives utilisent cet article' });
  db.prepare('DELETE FROM order_items WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ── Orders ────────────────────────────────────────────────────────────────────
app.get('/api/orders', (_, res) => {
  const orders = db.prepare(`
    SELECT o.*, oi.name AS item_name, u.username AS created_by_name
    FROM orders o
    JOIN order_items oi ON o.item_id = oi.id
    LEFT JOIN users u ON o.created_by = u.id
    ORDER BY o.created_at DESC
  `).all();
  for (const o of orders) {
    o.assignees = db.prepare(`
      SELECT u.id, u.username, u.avatar, u.discord_id
      FROM order_assignments oa JOIN users u ON oa.user_id = u.id
      WHERE oa.order_id = ?
    `).all(o.id);
  }
  res.json(orders);
});

app.post('/api/orders', async (req, res) => {
  const { item_id, quantity = 1, deadline, user_ids = [] } = req.body;
  if (!item_id) return res.status(400).json({ error: 'Article requis' });
  if (!Array.isArray(user_ids) || user_ids.length === 0)
    return res.status(400).json({ error: 'Assigne la commande à au moins une personne' });

  const item = db.prepare('SELECT * FROM order_items WHERE id=?').get(item_id);
  if (!item) return res.status(400).json({ error: 'Article introuvable' });

  const r = db.prepare('INSERT INTO orders (item_id, quantity, deadline, created_by) VALUES (?, ?, ?, ?)')
    .run(item_id, quantity, deadline || null, req.session.userId);
  const orderId = r.lastInsertRowid;

  const insAssign = db.prepare('INSERT OR IGNORE INTO order_assignments (order_id, user_id) VALUES (?, ?)');
  for (const uid of user_ids) insAssign.run(orderId, uid);

  // Notification Discord
  const token     = getSetting('discord_bot_token');
  const channelId = getSetting('discord_notify_channel_id');
  if (token && channelId) {
    try {
      const assignees = db.prepare(`
        SELECT u.username, u.discord_id
        FROM order_assignments oa JOIN users u ON oa.user_id = u.id
        WHERE oa.order_id = ?
      `).all(orderId);

      const mentions = assignees
        .filter(u => u.discord_id && u.discord_id !== '__admin__' && u.discord_id !== 'local')
        .map(u => `<@${u.discord_id}>`).join(' ');

      const deadlineStr = deadline
        ? new Date(deadline).toLocaleDateString('fr-FR')
        : 'Non définie';

      await botPost(`/channels/${channelId}/messages`, {
        content: mentions || null,
        embeds: [{
          title: '📦 Nouvelle commande !',
          color: 0xe67e22,
          fields: [
            { name: 'Article',    value: item.name,                                         inline: true },
            { name: 'Quantité',   value: String(quantity),                                  inline: true },
            { name: 'Deadline',   value: deadlineStr,                                       inline: true },
            { name: 'Assigné à',  value: assignees.map(u => u.username).join(', ') || '—', inline: false },
          ],
        }],
      }, token);
    } catch (e) {
      console.error('Order notification error:', e.message);
    }
  }

  res.json({ id: orderId });
});

app.put('/api/orders/:id', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Introuvable' });
  const user = db.prepare('SELECT is_admin FROM users WHERE id=?').get(req.session.userId);
  if (!user?.is_admin && order.created_by !== req.session.userId)
    return res.status(403).json({ error: 'Non autorisé' });

  const { item_id, quantity, deadline, user_ids } = req.body;
  db.prepare('UPDATE orders SET item_id=?, quantity=?, deadline=? WHERE id=?')
    .run(item_id, quantity, deadline || null, req.params.id);

  if (Array.isArray(user_ids)) {
    db.prepare('DELETE FROM order_assignments WHERE order_id=?').run(req.params.id);
    const ins = db.prepare('INSERT OR IGNORE INTO order_assignments (order_id, user_id) VALUES (?, ?)');
    for (const uid of user_ids) ins.run(req.params.id, uid);
  }
  res.json({ success: true });
});

app.post('/api/orders/:id/complete', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Introuvable' });
  const user = db.prepare('SELECT is_admin FROM users WHERE id=?').get(req.session.userId);
  if (!user?.is_admin && order.created_by !== req.session.userId)
    return res.status(403).json({ error: 'Non autorisé' });
  db.prepare("UPDATE orders SET status='done' WHERE id=?").run(req.params.id);
  res.json({ success: true });
});

app.delete('/api/orders/:id', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Introuvable' });
  const user = db.prepare('SELECT is_admin FROM users WHERE id=?').get(req.session.userId);
  if (!user?.is_admin && order.created_by !== req.session.userId)
    return res.status(403).json({ error: 'Non autorisé' });
  db.prepare('DELETE FROM orders WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

app.listen(3000, () => console.log('GTA Dashboard → http://localhost:3000'));

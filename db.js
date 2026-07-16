const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join('/app/data', 'gta.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS merchandise (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    grow_time_minutes INTEGER NOT NULL,
    color TEXT DEFAULT '#4CAF50'
  );

  CREATE TABLE IF NOT EXISTS points (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    merchandise_id INTEGER NOT NULL,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    position_type TEXT NOT NULL CHECK(position_type IN ('ground', 'elevated')),
    quantity INTEGER NOT NULL DEFAULT 1,
    planted_at TEXT NOT NULL,
    status TEXT DEFAULT 'growing' CHECK(status IN ('growing', 'ready', 'harvested')),
    notes TEXT DEFAULT '',
    FOREIGN KEY (merchandise_id) REFERENCES merchandise(id)
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id TEXT UNIQUE NOT NULL,
    username TEXT NOT NULL,
    avatar TEXT
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expired INTEGER NOT NULL
  );
`);

// Migrations idempotentes
try { db.exec(`ALTER TABLE points ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1`); } catch (_) {}
try { db.exec(`ALTER TABLE points ADD COLUMN environment TEXT NOT NULL DEFAULT 'exterior'`); } catch (_) {}
try { db.exec(`ALTER TABLE merchandise ADD COLUMN grow_time_interior INTEGER`); } catch (_) {}
try { db.exec(`ALTER TABLE points ADD COLUMN user_id INTEGER REFERENCES users(id)`); } catch (_) {}
try { db.exec(`ALTER TABLE points ADD COLUMN notified INTEGER DEFAULT 0`); } catch (_) {}
try { db.exec(`ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0`); } catch (_) {}
try { db.exec(`ALTER TABLE points ADD COLUMN location_name TEXT DEFAULT ''`); } catch (_) {}
try { db.exec(`ALTER TABLE points ADD COLUMN visibility TEXT DEFAULT 'shared'`); } catch (_) {}
try { db.exec(`ALTER TABLE points ADD COLUMN on_map INTEGER DEFAULT 1`); } catch (_) {}

// Valeur par défaut = même que l'extérieur pour les marchandises existantes
db.exec(`UPDATE merchandise SET grow_time_interior = grow_time_minutes WHERE grow_time_interior IS NULL`);
// Normaliser les colonnes ajoutées en migration sur les lignes existantes
db.exec(`UPDATE points SET visibility = 'shared' WHERE visibility IS NULL OR visibility = ''`);
db.exec(`UPDATE points SET on_map = 1 WHERE on_map IS NULL`);

const count = db.prepare('SELECT COUNT(*) as c FROM merchandise').get();
if (count.c === 0) {
  const ins = db.prepare('INSERT INTO merchandise (name, grow_time_minutes, color) VALUES (?, ?, ?)');
  ins.run('Weed',    45,  '#4CAF50');
  ins.run('Meth',    90,  '#2196F3');
  ins.run('Cocaine', 120, '#FF9800');
  ins.run('Crack',   30,  '#9C27B0');
}

module.exports = db;

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

  CREATE TABLE IF NOT EXISTS order_items (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    name     TEXT NOT NULL UNIQUE,
    category TEXT DEFAULT NULL
  );

  CREATE TABLE IF NOT EXISTS orders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id     INTEGER NOT NULL REFERENCES order_items(id),
    quantity    INTEGER NOT NULL DEFAULT 1,
    deadline    TEXT,
    status      TEXT NOT NULL DEFAULT 'pending',
    created_by  INTEGER REFERENCES users(id),
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS order_assignments (
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    user_id  INTEGER NOT NULL REFERENCES users(id),
    PRIMARY KEY (order_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS inventory (
    item_id    INTEGER PRIMARY KEY REFERENCES order_items(id) ON DELETE CASCADE,
    quantity   INTEGER NOT NULL DEFAULT 0,
    updated_by INTEGER REFERENCES users(id),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS harvest_log (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    point_id         INTEGER,
    merchandise_id   INTEGER NOT NULL,
    merchandise_name TEXT NOT NULL,
    merchandise_color TEXT DEFAULT '#4CAF50',
    quantity         INTEGER NOT NULL DEFAULT 1,
    user_id          INTEGER REFERENCES users(id),
    visibility       TEXT DEFAULT 'shared',
    location_name    TEXT DEFAULT '',
    harvested_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS recipes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id    INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
    ingredient_id INTEGER NOT NULL REFERENCES order_items(id),
    quantity      INTEGER NOT NULL DEFAULT 1,
    UNIQUE(product_id, ingredient_id)
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
try { db.exec(`ALTER TABLE order_items ADD COLUMN category TEXT DEFAULT NULL`); } catch (_) {}
try { db.exec(`ALTER TABLE order_items ADD COLUMN orderable INTEGER DEFAULT 1`); } catch (_) {}
try { db.exec(`ALTER TABLE orders ADD COLUMN discord_message_id TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE orders ADD COLUMN client TEXT DEFAULT NULL`); } catch (_) {}
try { db.exec(`ALTER TABLE order_items ADD COLUMN location TEXT DEFAULT NULL`); } catch (_) {}
try { db.exec(`ALTER TABLE users ADD COLUMN discord_notify INTEGER DEFAULT 1`); } catch (_) {}
try { db.exec(`ALTER TABLE orders ADD COLUMN sale_price INTEGER DEFAULT NULL`); } catch (_) {}
try { db.exec(`ALTER TABLE inventory_stock ADD COLUMN updated_by INTEGER REFERENCES users(id)`); } catch (_) {}

// Tables multi-lignes contrats + historique
db.exec(`
  CREATE TABLE IF NOT EXISTS order_lines (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    item_id  INTEGER NOT NULL REFERENCES order_items(id),
    quantity INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS order_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    new_status TEXT,
    user_id    INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Migration : peupler order_lines depuis les commandes existantes à item_id unique
{
  const hasLines = db.prepare('SELECT COUNT(*) AS c FROM order_lines').get();
  if (hasLines.c === 0) {
    db.exec(`
      INSERT INTO order_lines (order_id, item_id, quantity)
      SELECT id, item_id, COALESCE(quantity, 1)
      FROM orders WHERE item_id IS NOT NULL
    `);
    db.exec(`
      INSERT INTO order_events (order_id, event_type, new_status, created_at)
      SELECT id, 'created', status, created_at FROM orders
    `);
  }
}

// Nouvelles tables
db.exec(`
  CREATE TABLE IF NOT EXISTS stock_movements (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id    INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
    user_id    INTEGER REFERENCES users(id),
    delta      INTEGER NOT NULL,
    qty_after  INTEGER NOT NULL,
    note       TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS inventory_favorites (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, item_id)
  );

  CREATE TABLE IF NOT EXISTS inventory_stock (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id    INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    quantity   INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(item_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS contracts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    client     TEXT,
    deadline   TEXT,
    status     TEXT NOT NULL DEFAULT 'active',
    notes      TEXT DEFAULT '',
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    closed_at  TEXT
  );

  CREATE TABLE IF NOT EXISTS contract_lines (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id   INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    product_name  TEXT NOT NULL,
    qty_ordered   INTEGER NOT NULL DEFAULT 0,
    qty_delivered INTEGER NOT NULL DEFAULT 0,
    unit_price    INTEGER NOT NULL DEFAULT 0
  );
`);

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

// Produits commandables + matières premières — upsert idempotent
const upsertItem = db.prepare(`
  INSERT INTO order_items (name, category) VALUES (?, ?)
  ON CONFLICT(name) DO UPDATE SET category = excluded.category WHERE order_items.category IS NULL
`);
db.transaction(() => {
  [
    // Produits finis
    ['Sachet de Psilocybine',      'Psilocybine'],
    ['Caisse de Psilocybine',      'Psilocybine'],
    ['Gâteau spatial Psilocybine', 'Psilocybine'],
    ['Patch reposant',             'Psilocybine'],
    ['Sachet de Zeed',             'Zeed'],
    ['Caisse de Zeed',             'Zeed'],
    ['Joint de Zeed',              'Zeed'],
    ['Sachet de Pandoxine',        'Pandoxine'],
    ['Caisse de Pandoxine',        'Pandoxine'],
    ['Cookies relaxant',           'Pandoxine'],
    ['Cachet de Pandoxine',        'Pandoxine'],
    ['Boisson apaisante',          'Krakenine'],
    ['Sachet de Krakenine',        'Krakenine'],
    ['Caisse de Krakenine',        'Krakenine'],
    ['Seringue de Krakenine',      'Krakenine'],
    ['Sachet de Virus-Z',          'Virus-Z'],
    ['Seringue de Virus-Z',        'Virus-Z'],
    // Matières premières (ingrédients)
    ['Psilocybine traitée',        'Matières premières'],
    ['Zeed traitée',               'Matières premières'],
    ['Pandoxine traitée',          'Matières premières'],
    ['Krakenine traitée',          'Matières premières'],
    ['Virus Z',                    'Matières premières'],
  ].forEach(([n, c]) => upsertItem.run(n, c));
})();

// Consommables — non commandables (orderable = 0)
const upsertConsumable = db.prepare(`
  INSERT INTO order_items (name, category, orderable) VALUES (?, 'Consommables', 0)
  ON CONFLICT(name) DO UPDATE SET category = 'Consommables', orderable = 0
`);
db.transaction(() => {
  [
    'Bidon de chauffe',
    'Sac de fructification',
    'Pot de terre',
    'Marmite de fermentation',
  ].forEach(n => upsertConsumable.run(n));
})();

// Recettes — upsert idempotent par (product_id, ingredient_id)
const upsertRecipe = db.prepare(`
  INSERT INTO recipes (product_id, ingredient_id, quantity)
  SELECT p.id, i.id, ?
  FROM order_items p, order_items i
  WHERE p.name = ? AND i.name = ?
  ON CONFLICT(product_id, ingredient_id) DO UPDATE SET quantity = excluded.quantity
`);
db.transaction(() => {
  [
    // [quantité, nom_produit, nom_ingrédient]
    [5,  'Sachet de Psilocybine',      'Psilocybine traitée'],
    [20, 'Caisse de Psilocybine',      'Psilocybine traitée'],
    [2,  'Gâteau spatial Psilocybine', 'Psilocybine traitée'],
    [2,  'Patch reposant',             'Zeed traitée'],
    [2,  'Patch reposant',             'Psilocybine traitée'],
    [5,  'Sachet de Zeed',             'Zeed traitée'],
    [20, 'Caisse de Zeed',             'Zeed traitée'],
    [2,  'Joint de Zeed',              'Zeed traitée'],
    [3,  'Sachet de Pandoxine',        'Pandoxine traitée'],
    [12, 'Caisse de Pandoxine',        'Pandoxine traitée'],
    [2,  'Cookies relaxant',           'Zeed traitée'],
    [2,  'Cookies relaxant',           'Pandoxine traitée'],
    [2,  'Cachet de Pandoxine',        'Pandoxine traitée'],
    [2,  'Boisson apaisante',          'Zeed traitée'],
    [2,  'Boisson apaisante',          'Krakenine traitée'],
    [3,  'Sachet de Krakenine',        'Krakenine traitée'],
    [12, 'Caisse de Krakenine',        'Krakenine traitée'],
    [2,  'Seringue de Krakenine',      'Krakenine traitée'],
    [5,  'Sachet de Virus-Z',          'Virus Z'],
    [2,  'Seringue de Virus-Z',        'Virus Z'],
  ].forEach(([qty, product, ingredient]) => upsertRecipe.run(qty, product, ingredient));
})();

module.exports = db;

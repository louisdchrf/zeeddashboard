// ── Quartiers GTA V (coordonnées Leaflet CRS.Simple, carte 4096×4096) ─────────
// lat = 4096 - Y_pixel, lng = X_pixel
const GTA_DISTRICTS = [
  // Los Santos — ville
  { name: 'Vinewood',            lat: 1650, lng: 1950 },
  { name: 'Rockford Hills',      lat: 1750, lng: 1780 },
  { name: 'Burton',              lat: 1620, lng: 1820 },
  { name: 'Little Seoul',        lat: 1250, lng: 1670 },
  { name: 'Strawberry',          lat: 1150, lng: 1880 },
  { name: 'Davis',               lat: 980,  lng: 1920 },
  { name: 'Chamberlain Hills',   lat: 1000, lng: 1760 },
  { name: 'Cypress Flats',       lat: 1150, lng: 2120 },
  { name: 'La Mesa',             lat: 1350, lng: 2220 },
  { name: 'LSIA',                lat: 920,  lng: 1540 },
  { name: 'Vespucci Beach',      lat: 1300, lng: 1460 },
  { name: 'Del Perro',           lat: 1300, lng: 1360 },
  { name: 'Morningwood',         lat: 1450, lng: 1520 },
  { name: 'Pacific Bluffs',      lat: 1500, lng: 1240 },
  { name: 'Elysian Island',      lat: 820,  lng: 2280 },
  { name: 'Murrieta Heights',    lat: 1050, lng: 2180 },
  { name: 'El Burro Heights',    lat: 1150, lng: 2420 },
  // Collines / périphérie LS
  { name: 'Vinewood Hills',      lat: 1900, lng: 1660 },
  { name: 'Banham Canyon',       lat: 1750, lng: 1100 },
  { name: 'Tongva Hills',        lat: 1950, lng: 1160 },
  { name: 'Chumash',             lat: 1900, lng: 900  },
  // Blaine County
  { name: 'Fort Zancudo',        lat: 2200, lng: 1000 },
  { name: 'Lago Zancudo',        lat: 2350, lng: 1040 },
  { name: 'Raton Canyon',        lat: 2200, lng: 1360 },
  { name: 'Tataviam Mountains',  lat: 2300, lng: 1700 },
  { name: 'Mount Chiliad',       lat: 2750, lng: 1960 },
  { name: 'Harmony',             lat: 2400, lng: 2100 },
  { name: 'Grand Senora Desert', lat: 2700, lng: 2350 },
  { name: 'Alamo Sea',           lat: 2950, lng: 2620 },
  { name: 'Grapeseed',           lat: 2750, lng: 2780 },
  { name: 'Sandy Shores',        lat: 3100, lng: 2850 },
  { name: 'Mount Gordo',         lat: 3350, lng: 3100 },
  { name: 'Palomino Highlands',  lat: 1900, lng: 2800 },
  { name: 'Paleto Forest',       lat: 3400, lng: 1320 },
  { name: 'Paleto Bay',          lat: 3680, lng: 1080 },
];

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function findDistrict(lat, lng) {
  let nearest = null, minDist = Infinity;
  for (const d of GTA_DISTRICTS) {
    const dist = Math.hypot(d.lat - lat, d.lng - lng);
    if (dist < minDist) { minDist = dist; nearest = d; }
  }
  return nearest?.name || '';
}

// ── State ─────────────────────────────────────────────────────────────────────
let merchandise   = [];
let points        = [];
let currentUser   = null;
let pendingLatLng = null;
let modalSource   = 'map';   // 'map' | 'list'
let markers       = {};
let mapFilter     = 'all';  // 'all' | 'shared' | 'personal'
let listFilter    = 'all';  // 'all' | 'shared' | 'personal'
let orderFilters  = { status: '', assignee: '' };

// ── Map setup (initialisé en lazy car l'onglet carte n'est plus le défaut) ─────

const GTA_BOUNDS = [[0, 0], [4096, 4096]];

const map = L.map('map', {
  crs: L.CRS.Simple,
  minZoom: -2,
  maxZoom: 4,
  zoomControl: true,
  attributionControl: false,
});

L.imageOverlay('images/map_4k.png', GTA_BOUNDS).addTo(map);
map.fitBounds(GTA_BOUNDS);

document.querySelectorAll('.map-filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    mapFilter = btn.dataset.filter;
    document.querySelectorAll('.map-filter-btn').forEach(b => b.classList.toggle('active', b === btn));
    syncMarkers();
  });
});

map.on('contextmenu', (e) => { pendingLatLng = e.latlng; openPlantModal(); });

let _longPressTimer = null;
map.on('touchstart', (e) => {
  if (e.originalEvent.touches.length !== 1) return;
  const latlng = e.latlng;
  _longPressTimer = setTimeout(() => { pendingLatLng = latlng; openPlantModal(); }, 600);
});
map.on('touchend touchmove', () => { clearTimeout(_longPressTimer); _longPressTimer = null; });

// ── Tab navigation ────────────────────────────────────────────────────────────
function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b  => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.bnav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');
  if (tab === 'map')       map.invalidateSize();
  if (tab === 'list')      renderList();
  if (tab === 'orders')    renderOrders();
  if (tab === 'inventory') renderInventory();
  if (tab === 'recipes')   renderRecipes();
  if (tab === 'contracts') renderContracts();
  if (tab === 'stats')     loadAndRenderStats();
}

document.querySelectorAll('.tab-btn, .bnav-btn').forEach(btn =>
  btn.addEventListener('click', () => switchTab(btn.dataset.tab))
);

// ── API helpers ───────────────────────────────────────────────────────────────
const api = {
  get: async (url) => {
    const r = await fetch(url);
    if (r.status === 401) { window.location.reload(); return null; }
    return r.json();
  },
  post: async (url, body) => {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status === 401) { window.location.reload(); return null; }
    return r.json();
  },
  put: async (url, body) => {
    const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status === 401) { window.location.reload(); return null; }
    return r.json();
  },
  patch: async (url, body) => {
    const r = await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status === 401) { window.location.reload(); return null; }
    return r.json();
  },
  delete: async (url) => {
    const r = await fetch(url, { method: 'DELETE' });
    if (r.status === 401) { window.location.reload(); return null; }
    return r.json();
  },
};

// ── Auth ──────────────────────────────────────────────────────────────────────

async function checkAuth() {
  const meRes = await fetch('/auth/me');

  if (meRes.status === 401) {
    const config = await fetch('/auth/config').then(r => r.json());
    const ls = document.getElementById('login-screen');
    ls.style.display = 'flex';

    if (!config.adminExists) {
      document.getElementById('login-setup').style.display = 'block';
      document.getElementById('login-form').style.display  = 'none';
    } else {
      document.getElementById('login-setup').style.display = 'none';
      document.getElementById('login-form').style.display  = 'block';
      const discordDivider = document.getElementById('discord-divider');
      const discordBtn     = document.getElementById('discord-login-btn');
      discordDivider.style.display = config.discordConfigured ? 'flex' : 'none';
      discordBtn.style.display     = config.discordConfigured ? 'flex' : 'none';
    }

    // Afficher erreur si redirect depuis Discord avec ?error=
    const params = new URLSearchParams(window.location.search);
    const err = params.get('error');
    if (err === 'not_in_guild') {
      showLoginError('Accès refusé — tu n\'es pas membre du serveur Discord requis.');
    } else if (err) {
      showLoginError('Connexion Discord échouée. Vérifie la configuration dans les Paramètres admin.');
    }
    return null;
  }

  const user = await meRes.json();
  currentUser = user;

  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('user-name').textContent = user.username;

  fetch('/auth/config').then(r => r.json()).then(cfg => {
    const el = document.getElementById('app-version');
    if (el && cfg.version) el.textContent = 'v' + cfg.version;
  }).catch(() => {});

  if (user.avatar && user.discord_id !== '__admin__') {
    const avatarEl = document.getElementById('user-avatar');
    avatarEl.src = `https://cdn.discordapp.com/avatars/${user.discord_id}/${user.avatar}.png`;
    avatarEl.style.display = 'block';
  }

  if (user.is_admin) {
    document.querySelectorAll('.tab-admin, .bnav-admin').forEach(el => el.style.display = '');
  }

  return user;
}

function showLoginError(msg) {
  document.getElementById('login-error').textContent = msg;
}

// Setup (première connexion)
document.getElementById('btn-setup').addEventListener('click', async () => {
  const username = document.getElementById('setup-username').value.trim();
  const password = document.getElementById('setup-password').value;
  const r = await fetch('/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  }).then(x => x.json());
  if (r.success) window.location.reload();
  else showLoginError(r.error || 'Erreur');
});

// Connexion admin
document.getElementById('btn-admin-login').addEventListener('click', async () => {
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const r = await fetch('/auth/admin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  }).then(x => x.json());
  if (r.success) window.location.reload();
  else showLoginError(r.error || 'Identifiants incorrects');
});

// Enter sur les champs de login
['login-username', 'login-password', 'setup-username', 'setup-password'].forEach(id => {
  document.getElementById(id)?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const isSetup = id.startsWith('setup-');
    document.getElementById(isSetup ? 'btn-setup' : 'btn-admin-login').click();
  });
});

document.getElementById('btn-logout').addEventListener('click', () => {
  window.location.href = '/auth/logout';
});

// ── Data loaders ──────────────────────────────────────────────────────────────
async function loadMerchandise() {
  merchandise = await api.get('/api/merchandise');
  if (!merchandise) return;
  renderMerchGrid();
  populateMerchSelect();
}

async function loadPoints() {
  points = await api.get('/api/points');
  if (!points) return;
  syncMarkers();
  renderList();
}

async function loadSettings() {
  const data = await api.get('/api/settings');
  if (!data) return;
  document.getElementById('s-discord-client-id').value  = data.discord_client_id  || '';
  document.getElementById('s-discord-client-secret').value = '';
  if (data.discord_client_secret === '***') {
    document.getElementById('s-discord-client-secret').placeholder = '(défini — laisser vide pour conserver)';
  }
  document.getElementById('s-discord-redirect-uri').value = data.discord_redirect_uri || '';
  document.getElementById('s-discord-guild-id').value     = data.discord_guild_id     || '';
  document.getElementById('s-notify-channel-id').value    = data.discord_notify_channel_id || '';
  document.getElementById('s-orders-channel-id').value   = data.discord_orders_channel_id || '';
  document.getElementById('s-public-key').value           = data.discord_public_key || '';
  if (data.discord_bot_token === '***') {
    document.getElementById('s-bot-token').placeholder = '(défini — laisser vide pour conserver)';
  }
}

function populateMerchSelect() {
  document.getElementById('p-merch').innerHTML = merchandise.map(m =>
    `<option value="${m.id}">${m.name} (${formatDuration(m.grow_time_minutes)})</option>`
  ).join('');
}

// ── Map markers ───────────────────────────────────────────────────────────────
function syncMarkers() {
  const visibleIds = new Set(
    points
      .filter(p => p.on_map && (mapFilter === 'all' || p.visibility === mapFilter))
      .map(p => p.id)
  );
  for (const id of Object.keys(markers)) {
    if (!visibleIds.has(Number(id))) { markers[id].remove(); delete markers[id]; }
  }
  points.forEach(p => {
    if (!p.on_map) return;
    if (mapFilter !== 'all' && p.visibility !== mapFilter) return;
    if (markers[p.id]) { markers[p.id].setIcon(makeIcon(p)); return; }
    const marker = L.marker([p.lat, p.lng], { icon: makeIcon(p) }).addTo(map);
    marker.bindPopup(() => makePopup(p), { maxWidth: 240 });
    marker.on('popupopen', () => refreshPopup(p.id));
    markers[p.id] = marker;
  });
}

function makeIcon(p) {
  const isReady = p.status === 'ready';
  const emoji   = p.position_type === 'elevated' ? '🏔️' : '🌿';
  const total   = Number(p.effective_grow_time ?? p.grow_time_minutes) || 1;
  const elapsed = Math.floor((Date.now() - new Date(p.planted_at).getTime()) / 60000);
  const progress = isReady ? 1 : Math.min(0.99, Math.max(0, elapsed / total));
  const S = 44, cx = S / 2, r = 18, sw = 4;
  const circ = 2 * Math.PI * r;
  const dash = +(circ * progress).toFixed(3);
  const gap  = +(circ - dash).toFixed(3);
  const arcColor = isReady ? '#3fb950' : '#f0a500';
  const arcHtml = progress > 0
    ? `<circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="${arcColor}" stroke-width="${sw}"
        stroke-dasharray="${dash} ${gap}" stroke-linecap="butt" transform="rotate(-90 ${cx} ${cx})"/>`
    : '';
  const svg = `<svg width="${S}" height="${S}" viewBox="0 0 ${S} ${S}" xmlns="http://www.w3.org/2000/svg" class="${isReady ? 'icon-ready' : ''}">
    <circle cx="${cx}" cy="${cx}" r="${r}" fill="#0d1117cc" stroke="#30363d" stroke-width="${sw}"/>
    ${arcHtml}
    <text x="${cx}" y="${cx}" text-anchor="middle" dominant-baseline="central" font-size="15">${emoji}</text>
  </svg>`;
  return L.divIcon({ html: svg, className: '', iconSize: [S, S], iconAnchor: [cx, cx] });
}

function makePopup(p) {
  const elapsed   = p.elapsed_minutes || 0;
  const total     = p.effective_grow_time ?? p.grow_time_minutes;
  const remaining = Math.max(0, total - elapsed);
  const done      = p.status === 'ready';
  const planted   = new Date(p.planted_at).toLocaleString('fr-FR', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
  const timerHtml = done
    ? `<div class="popup-timer done">Prêt à récolter</div>`
    : `<div class="popup-timer running" id="pt-${p.id}">${formatDuration(remaining)}</div>`;
  const playerRow = p.player_name
    ? `<div class="popup-row"><span>Joueur</span><span>${escapeHtml(p.player_name)}</span></div>` : '';
  const locationRow = p.location_name
    ? `<div class="popup-row"><span>Quartier</span><span>${escapeHtml(p.location_name)}</span></div>` : '';
  return `<div class="popup-body">
    <div class="popup-title" style="color:${escapeHtml(p.color)}">${escapeHtml(p.merchandise_name)}</div>
    ${playerRow}
    ${locationRow}
    <div class="popup-row"><span>Quantité</span><span>${p.quantity} plant${p.quantity > 1 ? 's' : ''}</span></div>
    <div class="popup-row"><span>Position</span><span>${p.position_type === 'ground' ? 'Au sol' : 'En hauteur'}</span></div>
    <div class="popup-row"><span>Environnement</span><span>${(p.environment || 'exterior') === 'interior' ? 'Intérieur' : 'Extérieur'}</span></div>
    <div class="popup-row"><span>Planté le</span><span>${planted}</span></div>
    <div class="popup-row"><span>Durée totale</span><span>${formatDuration(total)}</span></div>
    ${p.notes ? `<div class="popup-row"><span>Note</span><span>${escapeHtml(p.notes)}</span></div>` : ''}
    ${timerHtml}
    <div class="popup-actions">
      <button class="btn-harvest" onclick="harvest(${p.id})">Récolter</button>
      <button class="btn-edit" onclick="openEditModal(${JSON.stringify(p).replace(/"/g, '&quot;')})">Modifier</button>
      <button class="btn-delete" onclick="deletePoint(${p.id})">Supprimer</button>
    </div>
  </div>`;
}

function refreshPopup(id) {
  const p = points.find(x => x.id === id);
  if (!p) return;
  const el = document.getElementById('pt-' + id);
  if (!el) return;
  const elapsed   = Math.floor((Date.now() - new Date(p.planted_at).getTime()) / 60000);
  const total     = p.effective_grow_time ?? p.grow_time_minutes;
  const remaining = Math.max(0, total - elapsed);
  if (remaining <= 0) { el.className = 'popup-timer done'; el.textContent = 'Prêt à récolter'; }
  else el.textContent = formatDuration(remaining);
}

// ── Radio helpers ─────────────────────────────────────────────────────────────
function bindRadioGroup(name, labels) {
  labels.forEach(({ id, value }) => {
    document.getElementById(id).addEventListener('click', () => {
      document.querySelector(`input[name=${name}][value=${value}]`).checked = true;
      labels.forEach(l => document.getElementById(l.id).classList.toggle('selected', l.value === value));
    });
  });
}
function setRadio(name, value, labels) {
  const el = document.querySelector(`input[name=${name}][value=${value}]`);
  if (el) el.checked = true;
  labels.forEach(l => document.getElementById(l.id).classList.toggle('selected', l.value === value));
}

bindRadioGroup('pos',  [{ id: 'lbl-ground',    value: 'ground'    }, { id: 'lbl-elevated',   value: 'elevated'  }]);
bindRadioGroup('env',  [{ id: 'lbl-exterior',  value: 'exterior'  }, { id: 'lbl-interior',   value: 'interior'  }]);
bindRadioGroup('vis',  [{ id: 'lbl-personal',  value: 'personal'  }, { id: 'lbl-shared',     value: 'shared'    }]);
bindRadioGroup('epos', [{ id: 'e-lbl-ground',  value: 'ground'    }, { id: 'e-lbl-elevated', value: 'elevated'  }]);
bindRadioGroup('eenv', [{ id: 'e-lbl-exterior',value: 'exterior'  }, { id: 'e-lbl-interior', value: 'interior'  }]);
bindRadioGroup('evis', [{ id: 'e-lbl-personal',value: 'personal'  }, { id: 'e-lbl-shared',   value: 'shared'    }]);

// ── Plant modal ───────────────────────────────────────────────────────────────
function openPlantModal(source = 'map') {
  modalSource = source;
  setRadio('pos', 'ground',   [{ id: 'lbl-ground',   value: 'ground'   }, { id: 'lbl-elevated', value: 'elevated' }]);
  setRadio('env', 'exterior', [{ id: 'lbl-exterior', value: 'exterior' }, { id: 'lbl-interior', value: 'interior' }]);
  document.getElementById('p-quantity').value = '1';
  document.getElementById('p-elapsed').value  = '0';
  document.getElementById('p-notes').value    = '';

  if (source === 'list') {
    // Hangar : partagée par défaut, pas de carte
    document.getElementById('p-location').value = 'Hangar';
    setRadio('vis', 'shared',   [{ id: 'lbl-personal', value: 'personal' }, { id: 'lbl-shared', value: 'shared' }]);
  } else {
    // Carte : lieu auto-détecté, personnelle par défaut
    document.getElementById('p-location').value = pendingLatLng
      ? findDistrict(pendingLatLng.lat, pendingLatLng.lng) : '';
    setRadio('vis', 'personal', [{ id: 'lbl-personal', value: 'personal' }, { id: 'lbl-shared', value: 'shared' }]);
  }

  document.getElementById('modal-plant').classList.add('active');
}

// Filtres liste
document.querySelectorAll('.list-filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    listFilter = btn.dataset.filter;
    document.querySelectorAll('.list-filter-btn').forEach(b => b.classList.toggle('active', b === btn));
    renderList();
  });
});

// Bouton "+ Ajouter" depuis la liste
document.getElementById('btn-add-list-plant').addEventListener('click', () => openPlantModal('list'));

document.getElementById('cancel-plant').addEventListener('click', () => {
  document.getElementById('modal-plant').classList.remove('active');
  pendingLatLng = null;
});

document.getElementById('confirm-plant').addEventListener('click', async () => {
  const isFromList = modalSource === 'list';
  if (!isFromList && !pendingLatLng) return;
  await api.post('/api/points', {
    merchandise_id:  Number(document.getElementById('p-merch').value),
    lat:             isFromList ? 0 : pendingLatLng.lat,
    lng:             isFromList ? 0 : pendingLatLng.lng,
    on_map:          isFromList ? 0 : 1,
    position_type:   document.querySelector('input[name=pos]:checked').value,
    environment:     document.querySelector('input[name=env]:checked').value,
    quantity:        Math.max(1, Number(document.getElementById('p-quantity').value) || 1),
    elapsed_minutes: Math.max(0, Number(document.getElementById('p-elapsed').value) || 0),
    notes:           document.getElementById('p-notes').value.trim(),
    location_name:   document.getElementById('p-location').value.trim(),
    visibility:      document.querySelector('input[name=vis]:checked').value,
  });
  document.getElementById('modal-plant').classList.remove('active');
  pendingLatLng = null;
  await loadPoints();
});

// ── Edit modal ────────────────────────────────────────────────────────────────
function openEditModal(p) {
  document.getElementById('e-id').value         = p.id;
  document.getElementById('e-planted-at').value = p.planted_at;
  document.getElementById('e-quantity').value   = p.quantity;
  document.getElementById('e-notes').value      = p.notes || '';
  document.getElementById('e-location').value   = p.location_name || (p.on_map ? findDistrict(p.lat, p.lng) : 'Hangar');
  document.getElementById('e-elapsed').value    = Math.floor((Date.now() - new Date(p.planted_at).getTime()) / 60000);
  setRadio('evis', p.visibility || 'shared', [{ id: 'e-lbl-personal', value: 'personal' }, { id: 'e-lbl-shared', value: 'shared' }]);
  document.getElementById('e-merch').innerHTML = merchandise.map(m =>
    `<option value="${m.id}" ${m.id === p.merchandise_id ? 'selected' : ''}>${m.name}</option>`
  ).join('');
  setRadio('epos', p.position_type,            [{ id: 'e-lbl-ground',   value: 'ground'   }, { id: 'e-lbl-elevated', value: 'elevated' }]);
  setRadio('eenv', p.environment || 'exterior', [{ id: 'e-lbl-exterior', value: 'exterior' }, { id: 'e-lbl-interior', value: 'interior' }]);
  document.getElementById('modal-edit').classList.add('active');
}
window.openEditModal = openEditModal;

document.getElementById('e-elapsed').addEventListener('input', () => {
  const mins = Math.max(0, Number(document.getElementById('e-elapsed').value) || 0);
  document.getElementById('e-planted-at').value = new Date(Date.now() - mins * 60000).toISOString();
});

document.getElementById('cancel-edit').addEventListener('click', () =>
  document.getElementById('modal-edit').classList.remove('active')
);

document.getElementById('confirm-edit').addEventListener('click', async () => {
  const id = document.getElementById('e-id').value;
  // Recalcul depuis planted_at (précis même si le modal est resté ouvert longtemps)
  const plantedAt     = document.getElementById('e-planted-at').value;
  const elapsed_minutes = Math.floor((Date.now() - new Date(plantedAt).getTime()) / 60000);
  const r = await api.put(`/api/points/${id}`, {
    merchandise_id:  Number(document.getElementById('e-merch').value),
    position_type:   document.querySelector('input[name=epos]:checked').value,
    environment:     document.querySelector('input[name=eenv]:checked').value,
    quantity:        Math.max(1, Number(document.getElementById('e-quantity').value) || 1),
    elapsed_minutes: Math.max(0, elapsed_minutes),
    notes:           document.getElementById('e-notes').value.trim(),
    location_name:   document.getElementById('e-location').value.trim(),
    visibility:      document.querySelector('input[name=evis]:checked').value,
  });
  if (r?.error) return alert(r.error);
  document.getElementById('modal-edit').classList.remove('active');
  map.closePopup();
  await loadPoints();
});

// ── Harvest / Delete ──────────────────────────────────────────────────────────
window.harvest = async (id) => {
  const r = await api.put(`/api/points/${id}/harvest`, {});
  if (r?.error) return alert(r.error);
  map.closePopup();
  await loadPoints();
};
window.deletePoint = async (id) => {
  if (!confirm('Supprimer ce plant ? Action irréversible.')) return;
  const r = await api.delete(`/api/points/${id}`);
  if (r?.error) return alert(r.error);
  map.closePopup();
  await loadPoints();
};

// ── Merchandise modal ─────────────────────────────────────────────────────────
function openMerchModal(m = null) {
  document.getElementById('merch-modal-title').textContent  = m ? 'Modifier' : 'Nouvelle marchandise';
  document.getElementById('m-id').value            = m ? m.id : '';
  document.getElementById('m-name').value          = m ? m.name : '';
  document.getElementById('m-time').value          = m ? m.grow_time_minutes : '';
  document.getElementById('m-time-interior').value = m ? (m.grow_time_interior ?? m.grow_time_minutes) : '';
  document.getElementById('m-color').value         = m ? m.color : '#4CAF50';
  document.getElementById('m-color-label').textContent = m ? m.color : '#4CAF50';
  document.getElementById('modal-merch').classList.add('active');
}
window.openMerchModal = openMerchModal;

document.getElementById('m-color').addEventListener('input', e =>
  document.getElementById('m-color-label').textContent = e.target.value
);
document.getElementById('btn-add-merch').addEventListener('click', () => openMerchModal());
document.getElementById('cancel-merch').addEventListener('click', () =>
  document.getElementById('modal-merch').classList.remove('active')
);

document.getElementById('confirm-merch').addEventListener('click', async () => {
  const id       = document.getElementById('m-id').value;
  const name     = document.getElementById('m-name').value.trim();
  const time     = Number(document.getElementById('m-time').value);
  const interior = Number(document.getElementById('m-time-interior').value) || time;
  const color    = document.getElementById('m-color').value;
  if (!name || !time) { alert('Nom et durée obligatoires.'); return; }
  const r = id
    ? await api.put(`/api/merchandise/${id}`, { name, grow_time_minutes: time, grow_time_interior: interior, color })
    : await api.post('/api/merchandise',       { name, grow_time_minutes: time, grow_time_interior: interior, color });
  if (r?.error) { alert(r.error); return; }
  document.getElementById('modal-merch').classList.remove('active');
  await loadMerchandise();
});

function renderMerchGrid() {
  const isAdmin = currentUser?.is_admin;
  document.getElementById('merch-grid').innerHTML = merchandise.map(m => `
    <div class="merch-card">
      <div class="merch-color-dot" style="background:${m.color}"></div>
      <div class="merch-info">
        <div class="name">${escapeHtml(m.name)}</div>
        <div class="time">Ext. ${formatDuration(m.grow_time_minutes)}</div>
        <div class="time">Int. ${formatDuration(m.grow_time_interior ?? m.grow_time_minutes)}</div>
      </div>
      ${isAdmin ? `<div class="merch-actions">
        <button class="btn-icon" onclick="openMerchModal(${JSON.stringify(m).replace(/"/g, '&quot;')})">✏️</button>
        <button class="btn-icon danger" onclick="deleteMerch(${m.id})">🗑️</button>
      </div>` : ''}
    </div>
  `).join('');
}

window.deleteMerch = async (id) => {
  if (!confirm('Supprimer cette marchandise ?')) return;
  const r = await api.delete(`/api/merchandise/${id}`);
  if (r?.error) { alert(r.error); return; }
  await loadMerchandise();
};

// ── List tab ──────────────────────────────────────────────────────────────────
function renderList() {
  const tbody = document.getElementById('list-body');
  const filtered = listFilter === 'all' ? points : points.filter(p => p.visibility === listFilter);
  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;color:var(--text2);padding:32px">Aucun plant actif</td></tr>`;
    return;
  }
  tbody.innerHTML = filtered.map(p => {
    const planted    = new Date(p.planted_at).toLocaleString('fr-FR', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
    const harvestAt  = new Date(new Date(p.planted_at).getTime() + (p.effective_grow_time ?? p.grow_time_minutes) * 60000);
    const harvestStr = harvestAt.toLocaleString('fr-FR', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
    const visIcon = p.visibility === 'personal' ? '🔒' : '👥';
    const lieu    = p.location_name || (p.on_map ? '—' : 'Hangar');
    return `<tr>
      <td><span style="color:${escapeHtml(p.color)};font-weight:600">${escapeHtml(p.merchandise_name)}</span></td>
      <td style="color:var(--text2);font-size:0.8rem">${escapeHtml(p.player_name) || '—'}</td>
      <td style="font-weight:600">${p.quantity}</td>
      <td><span class="pos-badge">${escapeHtml(lieu)}</span></td>
      <td><span class="pos-badge">${(p.environment || 'exterior') === 'interior' ? 'Int.' : 'Ext.'}</span></td>
      <td>${planted}</td>
      <td>${p.status === 'ready' ? '<span style="color:var(--green);font-weight:600">Maintenant</span>' : harvestStr}</td>
      <td><span class="badge ${p.status}">${p.status === 'ready' ? 'Prêt' : 'En pousse'}</span></td>
      <td><span class="vis-badge ${p.visibility === 'personal' ? 'personal' : 'shared'}">${visIcon} ${p.visibility === 'personal' ? 'Perso' : 'Équipe'}</span></td>
      <td>
        ${p.status === 'ready' ? `<button class="btn-icon" onclick="harvest(${p.id})" title="Récolter">✅</button>` : ''}
        <button class="btn-icon" onclick="openEditModal(${JSON.stringify(p).replace(/'/g, '&#39;').replace(/"/g, '&quot;')})" title="Modifier">✏️</button>
        <button class="btn-icon danger" onclick="deletePoint(${p.id})" title="Supprimer">🗑️</button>
      </td>
    </tr>`;
  }).join('');
}

// ── Settings tab (admin) ──────────────────────────────────────────────────────
function showStatus(elId, msg, ok = true) {
  const el = document.getElementById(elId);
  el.textContent = msg;
  el.style.color = ok ? 'var(--green)' : 'var(--red)';
  setTimeout(() => { el.textContent = ''; }, 4000);
}

// Auto-remplir l'URI de callback depuis l'URL du navigateur
document.getElementById('btn-fill-redirect').addEventListener('click', () => {
  document.getElementById('s-discord-redirect-uri').value = window.location.origin + '/auth/discord/callback';
});

document.getElementById('btn-save-discord').addEventListener('click', async () => {
  const payload = {
    discord_client_id:    document.getElementById('s-discord-client-id').value.trim(),
    discord_redirect_uri: document.getElementById('s-discord-redirect-uri').value.trim(),
    discord_guild_id:     document.getElementById('s-discord-guild-id').value.trim(),
  };
  const secret = document.getElementById('s-discord-client-secret').value;
  if (secret) payload.discord_client_secret = secret;
  const r = await api.put('/api/settings', payload);
  if (r?.success) showStatus('discord-settings-status', '✓ Paramètres Discord enregistrés');
  else showStatus('discord-settings-status', r?.error || 'Erreur', false);
});

document.getElementById('btn-save-bot').addEventListener('click', async () => {
  const payload = {
    discord_notify_channel_id: document.getElementById('s-notify-channel-id').value.trim(),
    discord_orders_channel_id: document.getElementById('s-orders-channel-id').value.trim(),
    discord_public_key:        document.getElementById('s-public-key').value.trim(),
  };
  const token = document.getElementById('s-bot-token').value;
  if (token) payload.discord_bot_token = token;
  const r = await api.put('/api/settings', payload);
  if (r?.success) showStatus('bot-status', '✓ Paramètres bot enregistrés');
  else showStatus('bot-status', r?.error || 'Erreur', false);
});

document.getElementById('btn-test-bot').addEventListener('click', async () => {
  const payload = { discord_notify_channel_id: document.getElementById('s-notify-channel-id').value.trim() };
  const token = document.getElementById('s-bot-token').value;
  if (token) payload.discord_bot_token = token;
  await api.put('/api/settings', payload);
  const r = await api.post('/api/settings/test-bot', {});
  if (r?.success) showStatus('bot-status', '✓ Message de test envoyé dans le salon');
  else showStatus('bot-status', r?.error || 'Erreur lors du test', false);
});

document.getElementById('btn-revoke-sessions').addEventListener('click', async () => {
  const r = await api.post('/api/admin/revoke-sessions', {});
  if (r?.success) showStatus('revoke-status', `✓ ${r.revoked} session(s) révoquée(s)`);
  else showStatus('revoke-status', r?.error || 'Erreur', false);
});

document.getElementById('btn-change-password').addEventListener('click', async () => {
  const pwd  = document.getElementById('s-new-password').value;
  const conf = document.getElementById('s-confirm-password').value;
  if (pwd !== conf) { showStatus('password-status', 'Les mots de passe ne correspondent pas', false); return; }
  const r = await api.post('/api/admin/password', { password: pwd });
  if (r?.success) {
    document.getElementById('s-new-password').value    = '';
    document.getElementById('s-confirm-password').value = '';
    showStatus('password-status', '✓ Mot de passe mis à jour');
  } else {
    showStatus('password-status', r?.error || 'Erreur', false);
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatDuration(minutes) {
  if (minutes <= 0) return '0 min';
  const h = Math.floor(minutes / 60), m = minutes % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}min`;
}

// ── Socket.io — temps réel ────────────────────────────────────────────────────
let socket = null;

function initSocket() {
  socket = io();

  socket.on('points:changed', async () => {
    await loadPoints();
    if (document.querySelector('.leaflet-popup')) points.forEach(p => refreshPopup(p.id));
  });

  socket.on('orders:changed', async () => {
    await loadOrders();
    const ordersTab = document.getElementById('tab-orders');
    if (ordersTab?.classList.contains('active')) renderOrders();
  });

  socket.on('inventory:changed', async () => {
    await loadInventory();
    await loadRecipes(); // stock mis à jour → recettes aussi
    const invTab = document.getElementById('tab-inventory');
    if (invTab?.classList.contains('active')) renderInventory();
    const recTab = document.getElementById('tab-recipes');
    if (recTab?.classList.contains('active')) renderRecipes();
  });

  socket.on('contracts:changed', async () => {
    await loadContracts();
    const cTab = document.getElementById('tab-contracts');
    if (cTab?.classList.contains('active')) renderContracts();
  });

  socket.on('users:online', (users) => renderPresence(users));
}

function renderPresence(users) {
  const el = document.getElementById('presence');
  if (!el) return;
  el.innerHTML = users.map(u => {
    const hasAvatar = u.avatar && u.discord_id && u.discord_id !== '__admin__';
    if (hasAvatar) {
      return `<img class="presence-avatar" src="https://cdn.discordapp.com/avatars/${u.discord_id}/${u.avatar}.png" title="${escapeHtml(u.username)}" alt="${escapeHtml(u.username)}"/>`;
    }
    return `<span class="presence-dot" title="${escapeHtml(u.username)}">${escapeHtml(u.username[0].toUpperCase())}</span>`;
  }).join('');
}

// Fallback poll si socket déconnecté
setInterval(async () => {
  if (socket?.connected) {
    if (document.querySelector('.leaflet-popup')) points.forEach(p => refreshPopup(p.id));
    return;
  }
  await loadPoints();
  if (document.querySelector('.leaflet-popup')) points.forEach(p => refreshPopup(p.id));
}, 60_000);

// ── Inventaire ────────────────────────────────────────────────────────────────
let inventory = [];
// Favoris inventaire (stockés en base, par compte)
let invFavorites = new Set();

async function loadInvFavorites() {
  const ids = await api.get('/api/inventory/favorites') || [];
  invFavorites = new Set(ids);
}

async function toggleFavorite(itemId) {
  if (invFavorites.has(itemId)) {
    invFavorites.delete(itemId);
    await api.delete(`/api/inventory/favorites/${itemId}`);
  } else {
    invFavorites.add(itemId);
    await api.post(`/api/inventory/favorites/${itemId}`, {});
  }
  renderInventory();
}

async function loadInventory() {
  inventory = await api.get('/api/inventory') || [];
}

function renderInventory() {
  const grid = document.getElementById('inventory-grid');
  if (!grid) return;

  if (inventory.length === 0) {
    grid.innerHTML = '<p style="color:var(--text2);padding:24px">Aucun article configuré.</p>';
    return;
  }

  const favs = invFavorites;

  // Grouper par catégorie
  const groups = {};
  const groupOrder = [];
  for (const item of inventory) {
    const cat = item.category || 'Autres';
    if (!groups[cat]) { groups[cat] = []; groupOrder.push(cat); }
    groups[cat].push(item);
  }

  function renderItem(item) {
    const isFav = favs.has(item.id);
    const myStock = (item.stocks || []).find(s => s.user_id === currentUser?.id);
    const myQty   = myStock?.quantity || 0;
    const visibleStocks = (item.stocks || []).filter(s => s.quantity > 0);

    const breakdown = visibleStocks.map(s =>
      `<span class="inv-user-stock${s.user_id === currentUser?.id ? ' inv-user-own' : ''}">${escapeHtml(s.username)}&thinsp;<b>${s.quantity}</b></span>`
    ).join('');

    const stopProp = `event.stopPropagation();`;
    return `
      <div class="inv-item${isFav ? ' inv-item-fav' : ''}" data-id="${item.id}" onclick="openStocksModal(${item.id})" style="cursor:pointer">
        <div class="inv-item-header">
          <div class="inv-item-name">${escapeHtml(item.name)}</div>
          <button class="inv-fav-btn${isFav ? ' active' : ''}" onclick="${stopProp}toggleFavorite(${item.id})" title="${isFav ? 'Retirer des favoris' : 'Ajouter aux favoris'}">★</button>
        </div>
        <div class="inv-item-qty ${item.total_quantity > 0 ? 'qty-positive' : 'qty-zero'}" id="inv-total-${item.id}">${item.total_quantity}</div>
        <div class="inv-breakdown" id="inv-breakdown-${item.id}">${breakdown}</div>
        ${item.location ? `<div class="inv-item-location">📍 ${escapeHtml(item.location)}</div>` : ''}
      </div>
    `;
  }

  let html = '';

  // Section Favoris en premier
  const favItems = inventory.filter(i => favs.has(i.id));
  if (favItems.length > 0) {
    html += `<div class="inv-section">
      <div class="inv-section-header inv-section-fav">★ Favoris <span class="inv-section-count">${favItems.length}</span></div>
      <div class="inv-group-items">${favItems.map(renderItem).join('')}</div>
    </div>`;
  }

  // Sections par catégorie
  for (const cat of groupOrder) {
    html += `<div class="inv-section">
      <div class="inv-section-header">${escapeHtml(cat)} <span class="inv-section-count">${groups[cat].length}</span></div>
      <div class="inv-group-items">${groups[cat].map(renderItem).join('')}</div>
    </div>`;
  }

  grid.innerHTML = html;
}

async function adjustInventory(itemId, direction) {
  const adj = parseInt(document.getElementById(`inv-adj-${itemId}`)?.value) || 1;
  const delta = direction * adj;
  const r = await api.put(`/api/inventory/${itemId}`, { delta });
  if (r?.error) return alert(r.error);

  // Mise à jour locale immédiate
  const item = inventory.find(i => i.id === itemId);
  if (item) {
    if (!item.stocks) item.stocks = [];
    const myStock = item.stocks.find(s => s.user_id === currentUser?.id);
    if (myStock) {
      myStock.quantity = r.quantity;
    } else if (r.quantity > 0) {
      item.stocks.push({ user_id: currentUser.id, username: currentUser.username, quantity: r.quantity });
    }
    item.total_quantity = item.stocks.reduce((sum, s) => sum + s.quantity, 0);

    const totalEl = document.getElementById(`inv-total-${itemId}`);
    if (totalEl) {
      totalEl.textContent = item.total_quantity;
      totalEl.className = `inv-item-qty ${item.total_quantity > 0 ? 'qty-positive' : 'qty-zero'}`;
    }
    const myQtyEl = document.getElementById(`inv-my-qty-${itemId}`);
    if (myQtyEl) myQtyEl.textContent = r.quantity;
    const breakdownEl = document.getElementById(`inv-breakdown-${itemId}`);
    if (breakdownEl) {
      const visibleStocks = item.stocks.filter(s => s.quantity > 0);
      breakdownEl.innerHTML = visibleStocks.map(s =>
        `<span class="inv-user-stock${s.user_id === currentUser?.id ? ' inv-user-own' : ''}">${escapeHtml(s.username)}&thinsp;<b>${s.quantity}</b></span>`
      ).join('');
    }
  }
}

// ── Stats ─────────────────────────────────────────────────────────────────────
async function loadAndRenderStats() {
  const data = await api.get('/api/stats');
  if (!data) return;

  // KPIs
  document.getElementById('stats-kpis').innerHTML = `
    <div class="kpi-card">
      <div class="kpi-value">${data.totals?.plants || 0}</div>
      <div class="kpi-label">Plants récoltés</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-value">${data.totals?.harvests || 0}</div>
      <div class="kpi-label">Récoltes effectuées</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-value">${data.byMerch.length}</div>
      <div class="kpi-label">Types de drogue</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-value">${data.byPlayer.length}</div>
      <div class="kpi-label">Membres actifs</div>
    </div>
  `;

  // Par marchandise — barres CSS
  const maxMerch = Math.max(...data.byMerch.map(m => m.total), 1);
  document.getElementById('stats-by-merch').innerHTML = data.byMerch.length === 0
    ? '<p class="empty-state">Aucune récolte enregistrée</p>'
    : data.byMerch.map(m => `
      <div class="stat-bar-row">
        <span class="stat-bar-label">${escapeHtml(m.merchandise_name)}</span>
        <div class="stat-bar-track">
          <div class="stat-bar-fill" style="width:${Math.round(m.total/maxMerch*100)}%;background:${escapeHtml(m.merchandise_color)}"></div>
        </div>
        <span class="stat-bar-value">${m.total}</span>
      </div>
    `).join('');

  // Leaderboard
  document.getElementById('stats-by-player').innerHTML = data.byPlayer.length === 0
    ? '<p class="empty-state">Aucune récolte enregistrée</p>'
    : data.byPlayer.map((p, i) => {
      const hasAvatar = p.avatar && p.discord_id && p.discord_id !== '__admin__';
      const avatarHtml = hasAvatar
        ? `<img class="presence-avatar" src="https://cdn.discordapp.com/avatars/${p.discord_id}/${p.avatar}.png" alt=""/>`
        : `<span class="presence-dot">${(p.username||'?')[0].toUpperCase()}</span>`;
      return `<div class="leaderboard-row">
        <span class="lb-rank">#${i+1}</span>
        ${avatarHtml}
        <span class="lb-name">${escapeHtml(p.username || 'Inconnu')}</span>
        <span class="lb-total">${p.total} plants</span>
        <span class="lb-harvests">(${p.harvests} récoltes)</span>
      </div>`;
    }).join('');

  // Graphe 7 jours
  const days7El = document.getElementById('stats-last7');
  if (data.last7days.length === 0) {
    days7El.innerHTML = '<p class="empty-state">Pas de données sur 7 jours</p>';
  } else {
    const max7 = Math.max(...data.last7days.map(d => d.total), 1);
    const allDays = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      allDays.push(d.toISOString().slice(0, 10));
    }
    days7El.innerHTML = `<div class="bar-chart-inner">${allDays.map(day => {
      const found = data.last7days.find(d => d.day === day);
      const total = found?.total || 0;
      const h = Math.round(total / max7 * 100);
      const label = new Date(day + 'T12:00:00').toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' });
      return `<div class="bar-col">
        <div class="bar-tip">${total || ''}</div>
        <div class="bar-body" style="height:${h}%"></div>
        <div class="bar-label">${label}</div>
      </div>`;
    }).join('')}</div>`;
  }

  // Feed récent
  document.getElementById('stats-feed').innerHTML = data.recentFeed.length === 0
    ? '<p class="empty-state">Aucune récolte enregistrée</p>'
    : data.recentFeed.map(h => {
      const when = new Date(h.harvested_at + 'Z').toLocaleString('fr-FR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
      return `<div class="feed-row">
        <span class="feed-dot" style="background:${escapeHtml(h.merchandise_color)}"></span>
        <span class="feed-merch">${escapeHtml(h.merchandise_name)}</span>
        <span class="feed-qty">×${h.quantity}</span>
        ${h.location_name ? `<span class="feed-loc">📍 ${escapeHtml(h.location_name)}</span>` : ''}
        <span class="feed-player">${escapeHtml(h.username || '—')}</span>
        <span class="feed-time">${when}</span>
      </div>`;
    }).join('');

  // Stats ventes par produit (contrats)
  const salesData = await api.get('/api/contracts/stats') || [];
  const salesEl = document.getElementById('stats-by-product');
  if (salesEl) {
    if (salesData.length === 0) {
      salesEl.innerHTML = '<p class="empty-state">Aucune donnée — crée des contrats avec des livraisons</p>';
    } else {
      const maxRev = Math.max(...salesData.map(s => s.total_revenue), 1);
      salesEl.innerHTML = salesData.map(s => `
        <div class="bar-row">
          <span class="bar-label">${escapeHtml(s.product_name)}</span>
          <div class="bar-track">
            <div class="bar-fill" style="width:${Math.round((s.total_revenue / maxRev) * 100)}%;background:var(--accent)"></div>
          </div>
          <span class="bar-val">$${s.total_revenue.toLocaleString('fr-FR')} <span style="color:var(--text2);font-size:.75rem">(${s.total_delivered} livrés)</span></span>
        </div>
      `).join('');
    }
  }
}

// ── Recettes ──────────────────────────────────────────────────────────────────
let recipes = [];

async function loadRecipes() {
  recipes = await api.get('/api/recipes') || [];
}

function renderRecipes() {
  const grid = document.getElementById('recipes-grid');
  if (!grid) return;

  const qty = parseInt(document.getElementById('recipe-qty')?.value) || 1;

  if (recipes.length === 0) {
    grid.innerHTML = '<p style="color:var(--text2);padding:24px">Aucune recette configurée.</p>';
    return;
  }

  // Grouper par catégorie (ordre d'apparition)
  const groups = {};
  const groupOrder = [];
  for (const r of recipes) {
    const cat = r.category || 'Autres';
    if (!groups[cat]) { groups[cat] = []; groupOrder.push(cat); }
    groups[cat].push(r);
  }

  grid.innerHTML = groupOrder.map(cat => `
    <div class="recipe-group">
      <h3 class="recipe-group-title">${escapeHtml(cat)}</h3>
      <div class="recipe-cards">
        ${groups[cat].map(product => {
          const ingredientsHtml = product.ingredients.map(ing => {
            const needed = ing.quantity * qty;
            return `<div class="recipe-ingredient">
              <span class="recipe-ing-name">${escapeHtml(ing.name)}</span>
              <span class="recipe-ing-qty"><span class="needed">${needed}</span></span>
            </div>`;
          }).join('');

          return `<div class="recipe-card">
            <div class="recipe-card-header">
              <span class="recipe-product-name">${escapeHtml(product.name)}</span>
            </div>
            <div class="recipe-ingredients">${ingredientsHtml}</div>
          </div>`;
        }).join('')}
      </div>
    </div>
  `).join('');
}

document.getElementById('recipe-qty')?.addEventListener('input', () => renderRecipes());

// ── Commandes ─────────────────────────────────────────────────────────────────
let orderItems = [];
let orders     = [];
let allUsers   = [];

async function loadOrderItems() {
  orderItems = await api.get('/api/order-items') || [];
}

async function loadOrders() {
  orders = await api.get('/api/orders') || [];
}

async function loadUsers() {
  allUsers = await api.get('/api/users') || [];
}

function populateOrderAssigneeFilter() {
  const sel = document.getElementById('filter-order-assignee');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">Tous les membres</option>' +
    allUsers.map(u => `<option value="${u.id}" ${String(u.id) === current ? 'selected' : ''}>${escapeHtml(u.username)}</option>`).join('');
}

function renderOrders() {
  const tbody = document.getElementById('orders-body');
  if (!tbody) return;

  // Appliquer les filtres
  const statusOrder = { pending: 0, in_progress: 1, to_deliver: 2, done: 3 };
  let filtered = [...orders];
  if (orderFilters.status)   filtered = filtered.filter(o => o.status === orderFilters.status);
  if (orderFilters.assignee) filtered = filtered.filter(o => o.assignees.some(u => String(u.id) === orderFilters.assignee));
  filtered.sort((a, b) => (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9));

  // Compteur
  const countEl = document.getElementById('orders-count');
  if (countEl) {
    const total = orders.length;
    const shown = filtered.length;
    countEl.textContent = (orderFilters.status || orderFilters.assignee)
      ? `${shown} / ${total} commande${total > 1 ? 's' : ''}`
      : `${total} commande${total > 1 ? 's' : ''}`;
  }

  tbody.innerHTML = filtered.length === 0
    ? '<tr><td colspan="8" style="text-align:center;color:var(--text2);padding:24px">Aucune commande</td></tr>'
    : filtered.map(o => {
        const deadline = o.deadline
          ? new Date(o.deadline).toLocaleDateString('fr-FR')
          : '<span style="color:var(--text2)">—</span>';

        const assignees = o.assignees.map(u =>
          `<span class="assignee-tag">${escapeHtml(u.username)}</span>`
        ).join('');

        const statusSelect = `
          <select class="status-inline status-${o.status}"
            onclick="event.stopPropagation()"
            onchange="quickChangeStatus(${o.id}, this.value, this)">
            <option value="pending"     ${o.status==='pending'     ? 'selected':''}>⏳ En attente</option>
            <option value="in_progress" ${o.status==='in_progress' ? 'selected':''}>🔄 En cours</option>
            <option value="to_deliver"  ${o.status==='to_deliver'  ? 'selected':''}>📦 À livrer</option>
            <option value="done"        ${o.status==='done'        ? 'selected':''}>✅ Terminée</option>
          </select>`;

        const stopProp = `event.stopPropagation();`;
        const actions = `<button class="btn-icon danger" onclick="${stopProp}deleteOrder(${o.id})">🗑️</button>`;
        const priceCell = o.status === 'done'
          ? (o.sale_price != null ? `<span class="sale-price-tag">$${o.sale_price.toLocaleString('fr-FR')}</span>` : '<span style="color:var(--text2)">—</span>')
          : '';

        return `<tr class="${o.status === 'done' ? 'order-done' : ''} order-row" onclick="openEditOrderModal(${o.id})">
          <td>${escapeHtml(o.item_name)}</td>
          <td>${o.quantity}</td>
          <td>${o.client ? `<span class="client-tag">${escapeHtml(o.client)}</span>` : '<span style="color:var(--text2)">—</span>'}</td>
          <td>${deadline}</td>
          <td>${assignees || '—'}</td>
          <td>${statusSelect}</td>
          <td>${priceCell}</td>
          <td class="actions-cell">${actions}</td>
        </tr>`;
      }).join('');

  populateOrderAssigneeFilter();
}

async function quickChangeStatus(orderId, newStatus, selectEl) {
  let sale_price = null;
  if (newStatus === 'done') {
    const input = prompt('Prix de vente de la commande ($) :');
    if (input === null) {
      // Annulé — remettre l'ancienne valeur
      const o = orders.find(x => x.id === orderId);
      if (o) selectEl.value = o.status;
      return;
    }
    sale_price = input.trim() !== '' ? parseInt(input) || null : null;
  }
  selectEl.disabled = true;
  const r = await api.patch(`/api/orders/${orderId}/status`, { status: newStatus, sale_price });
  selectEl.disabled = false;
  if (r?.error) {
    alert(r.error);
    const o = orders.find(x => x.id === orderId);
    if (o) selectEl.value = o.status;
    return;
  }
  await loadOrders();
  renderOrders();
}

function renderOrderItemsList() {
  const el = document.getElementById('order-items-list');
  if (!el) return;
  el.innerHTML = orderItems.length === 0
    ? '<p style="color:var(--text2);font-size:.85rem;padding:8px 0">Aucun article — ajoute-en un ci-dessous.</p>'
    : orderItems.map(item => `
        <div class="order-item-row">
          <div>
            <span>${escapeHtml(item.name)}</span>
            ${item.location ? `<span style="font-size:.75rem;color:var(--text2);margin-left:8px">📍 ${escapeHtml(item.location)}</span>` : ''}
          </div>
          <div style="display:flex;gap:6px">
            <button class="btn-edit" onclick="openEditOrderItemModal(${item.id}, '${escapeHtml(item.name).replace(/'/g, "\\'")}', '${escapeHtml(item.location || '').replace(/'/g, "\\'")}')">✏️</button>
            <button class="btn-delete" onclick="deleteOrderItem(${item.id})">🗑️</button>
          </div>
        </div>
      `).join('');
}

function populateOrderItemSelect(selectedId = null) {
  const sel = document.getElementById('o-item');
  sel.innerHTML = orderItems.length === 0
    ? '<option value="">— Aucun article disponible —</option>'
    : orderItems.map(i =>
        `<option value="${i.id}" ${i.id == selectedId ? 'selected' : ''}>${escapeHtml(i.name)}</option>`
      ).join('');
}

function populateAssigneeCheckboxes(selectedIds = []) {
  const container = document.getElementById('o-assignees');
  const eligible = allUsers.filter(u => !u.is_admin && u.discord_id !== '__admin__' && u.discord_id !== 'local');
  container.innerHTML = eligible.length === 0
    ? '<p style="color:var(--text2);font-size:.85rem">Aucun utilisateur disponible.</p>'
    : eligible.map(u => `
        <label class="assignee-checkbox">
          <input type="checkbox" value="${u.id}" ${selectedIds.includes(u.id) ? 'checked' : ''}/>
          ${escapeHtml(u.username)}
        </label>
      `).join('');
}

function updateOrderIngredientsPreview() {
  const preview = document.getElementById('order-ingredients-preview');
  const rows    = document.getElementById('oip-rows');
  if (!preview || !rows) return;

  const itemId  = parseInt(document.getElementById('o-item')?.value);
  const qty     = parseInt(document.getElementById('o-quantity')?.value) || 1;

  // Trouver la recette correspondant au produit sélectionné
  const recipe = recipes.find(r => r.id === itemId);

  if (!recipe || !recipe.ingredients || recipe.ingredients.length === 0) {
    preview.style.display = 'none';
    return;
  }

  preview.style.display = 'block';

  let allOk = true;
  rows.innerHTML = recipe.ingredients.map(ing => {
    const needed = ing.quantity * qty;
    const ok = ing.stock >= needed;
    if (!ok) allOk = false;
    return `<div class="oip-row">
      <span class="oip-ing-name">${escapeHtml(ing.name)}</span>
      <span class="oip-ing-qty ${ok ? 'oip-ok' : 'oip-low'}">
        ${needed} <span class="oip-stock">(stock : ${ing.stock})</span>
      </span>
    </div>`;
  }).join('');

  preview.className = `order-ingredients-preview ${allOk ? 'oip-feasible' : 'oip-infeasible'}`;
}

function openNewOrderModal() {
  document.getElementById('o-id').value = '';
  document.getElementById('order-modal-title').textContent = 'Nouvelle commande';
  document.getElementById('o-quantity').value = 1;
  document.getElementById('o-deadline').value = '';
  // S'assurer que les champs sont activés
  ['o-item', 'o-quantity', 'o-deadline'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = false;
  });
  document.getElementById('confirm-order').style.display = '';
  document.getElementById('o-status-group').style.display = 'none';
  const spg = document.getElementById('o-sale-price-group');
  if (spg) { spg.style.display = 'none'; document.getElementById('o-sale-price').value = ''; }
  document.getElementById('o-client').value = '';
  populateOrderItemSelect();
  populateAssigneeCheckboxes();
  document.getElementById('modal-order').style.display = 'flex';
  updateOrderIngredientsPreview();
}

function openEditOrderModal(id) {
  const o = orders.find(x => x.id === id);
  if (!o) return;
  // Commandes admin → seul admin peut modifier. Commandes user → tout le monde peut modifier.
  const canAct = currentUser?.is_admin || !o.created_by_is_admin;

  document.getElementById('o-id').value = id;
  document.getElementById('order-modal-title').textContent = canAct ? 'Modifier la commande' : 'Détails de la commande';
  document.getElementById('o-quantity').value = o.quantity;
  document.getElementById('o-deadline').value = o.deadline ? o.deadline.slice(0, 10) : '';
  document.getElementById('o-client').value = o.client || '';

  // Champs en lecture seule si pas de droits
  ['o-item', 'o-quantity', 'o-deadline', 'o-status'].forEach(fieldId => {
    const el = document.getElementById(fieldId);
    if (el) el.disabled = !canAct;
  });
  document.getElementById('confirm-order').style.display = canAct ? '' : 'none';

  // Statut — visible uniquement en mode édition
  const statusGroup = document.getElementById('o-status-group');
  statusGroup.style.display = '';
  document.getElementById('o-status').value = o.status || 'pending';

  // Prix de vente — visible si statut = done
  const salePriceGroup = document.getElementById('o-sale-price-group');
  if (salePriceGroup) {
    salePriceGroup.style.display = o.status === 'done' ? '' : 'none';
    document.getElementById('o-sale-price').value = o.sale_price ?? '';
  }

  populateOrderItemSelect(o.item_id);
  populateAssigneeCheckboxes(o.assignees.map(u => u.id));
  if (!canAct) {
    document.querySelectorAll('#o-assignees input').forEach(cb => cb.disabled = true);
  }

  document.getElementById('modal-order').style.display = 'flex';

  const sel = document.getElementById('o-item');
  if (sel) sel.value = o.item_id;
  updateOrderIngredientsPreview();
}

function onOrderStatusChange(val) {
  const group = document.getElementById('o-sale-price-group');
  if (group) group.style.display = val === 'done' ? '' : 'none';
}

function closeOrderModal() {
  document.getElementById('modal-order').style.display = 'none';
}

document.getElementById('btn-add-order').addEventListener('click', openNewOrderModal);
document.getElementById('cancel-order').addEventListener('click', closeOrderModal);

// ── Filtres commandes ─────────────────────────────────────────────────────────
document.getElementById('filter-order-status').addEventListener('change', e => {
  orderFilters.status = e.target.value;
  renderOrders();
});

document.getElementById('filter-order-assignee').addEventListener('change', e => {
  orderFilters.assignee = e.target.value;
  renderOrders();
});

document.getElementById('btn-reset-order-filters').addEventListener('click', () => {
  orderFilters = { status: '', assignee: '' };
  document.getElementById('filter-order-status').value = '';
  document.getElementById('filter-order-assignee').value = '';
  renderOrders();
});

// Preview ingrédients live à la création
document.getElementById('o-item')?.addEventListener('change', updateOrderIngredientsPreview);
document.getElementById('o-quantity')?.addEventListener('input', updateOrderIngredientsPreview);


document.getElementById('confirm-order').addEventListener('click', async () => {
  const id       = document.getElementById('o-id').value;
  const item_id  = document.getElementById('o-item').value;
  const quantity = parseInt(document.getElementById('o-quantity').value) || 1;
  const deadline = document.getElementById('o-deadline').value || null;
  const user_ids = [...document.querySelectorAll('#o-assignees input[type=checkbox]:checked')]
    .map(cb => parseInt(cb.value));

  if (!item_id) return alert('Sélectionne un article.');
  if (user_ids.length === 0) return alert('Assigne la commande à au moins une personne.');

  const status = document.getElementById('o-status')?.value || 'pending';
  const client = document.getElementById('o-client')?.value?.trim() || null;
  const salePriceRaw = document.getElementById('o-sale-price')?.value?.trim();
  const sale_price = status === 'done' && salePriceRaw !== '' ? (parseInt(salePriceRaw) || null) : null;
  const body = { item_id: parseInt(item_id), quantity, deadline, user_ids, status, client, sale_price };
  const r = id
    ? await api.put(`/api/orders/${id}`, body)
    : await api.post('/api/orders', body);

  if (r?.error) return alert(r.error);
  closeOrderModal();
  await loadOrders();
  renderOrders();
});

async function progressOrder(id) {
  const r = await api.post(`/api/orders/${id}/progress`, {});
  if (r?.error) return alert(r.error);
  await loadOrders();
  renderOrders();
}

async function completeOrder(id) {
  if (!confirm('Marquer cette commande comme terminée ?')) return;
  const r = await api.post(`/api/orders/${id}/complete`, {});
  if (r?.error) return alert(r.error);
  await loadOrders();
  renderOrders();
}

async function deleteOrder(id) {
  if (!confirm('Supprimer cette commande ?')) return;
  const r = await api.delete(`/api/orders/${id}`);
  if (r?.error) return alert(r.error);
  await loadOrders();
  renderOrders();
}

// ── Articles commandables (admin) ─────────────────────────────────────────────
document.getElementById('btn-manage-order-items').addEventListener('click', () => {
  renderOrderItemsList();
  document.getElementById('oi-name').value = '';
  document.getElementById('modal-order-items-mgmt').style.display = 'flex';
});

document.getElementById('close-order-items-mgmt').addEventListener('click', () => {
  document.getElementById('modal-order-items-mgmt').style.display = 'none';
});

document.getElementById('btn-add-order-item').addEventListener('click', async () => {
  const name = document.getElementById('oi-name').value.trim();
  if (!name) return alert('Nom requis.');
  const r = await api.post('/api/order-items', { name });
  if (r?.error) return alert(r.error);
  document.getElementById('oi-name').value = '';
  await loadOrderItems();
  renderOrderItemsList();
  populateOrderItemSelect();
});

document.getElementById('oi-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('btn-add-order-item').click();
});

function openEditOrderItemModal(id, currentName, currentLocation) {
  document.getElementById('oi-edit-id').value = id;
  document.getElementById('oi-edit-name').value = currentName;
  document.getElementById('oi-edit-location').value = currentLocation || '';
  document.getElementById('modal-order-item-edit').style.display = 'flex';
}

document.getElementById('cancel-order-item-edit').addEventListener('click', () => {
  document.getElementById('modal-order-item-edit').style.display = 'none';
});

document.getElementById('confirm-order-item-edit').addEventListener('click', async () => {
  const id       = document.getElementById('oi-edit-id').value;
  const name     = document.getElementById('oi-edit-name').value.trim();
  const location = document.getElementById('oi-edit-location').value.trim();
  if (!name) return alert('Nom requis.');
  const r = await api.put(`/api/order-items/${id}`, { name, location });
  if (r?.error) return alert(r.error);
  document.getElementById('modal-order-item-edit').style.display = 'none';
  await loadOrderItems();
  renderOrderItemsList();
  populateOrderItemSelect();
});

async function deleteOrderItem(id) {
  if (!confirm('Supprimer cet article ?')) return;
  const r = await api.delete(`/api/order-items/${id}`);
  if (r?.error) return alert(r.error);
  await loadOrderItems();
  renderOrderItemsList();
  populateOrderItemSelect();
}

// ── Modal : attribution du stock par membre ───────────────────────────────────

function openStocksModal(itemId) {
  const item = inventory.find(i => i.id === itemId);
  if (!item) return;

  document.getElementById('inv-stocks-title').textContent = escapeHtml(item.name);
  document.getElementById('inv-stocks-item-id').value = itemId;

  const stockMap = {};
  for (const s of (item.stocks || [])) stockMap[s.user_id] = s;

  const rows = document.getElementById('inv-stocks-rows');
  const members = allUsers.filter(u => !u.is_admin && u.discord_id !== '__admin__' && u.discord_id !== 'local');
  rows.innerHTML = members.map(u => {
    const s = stockMap[u.id];
    let meta = '';
    if (s?.updated_at) {
      const d = new Date(s.updated_at + 'Z');
      const dateStr = d.toLocaleDateString('fr-FR') + ' ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      const by = s.updated_by_name ? ` par ${escapeHtml(s.updated_by_name)}` : '';
      meta = `<span class="inv-stocks-meta">${dateStr}${by}</span>`;
    }
    return `
    <div class="inv-stocks-row">
      <label class="inv-stocks-label">
        ${u.avatar ? `<img src="https://cdn.discordapp.com/avatars/${u.discord_id}/${u.avatar}.png" class="inv-stocks-avatar"/>` : '<span class="inv-stocks-avatar-placeholder"></span>'}
        ${escapeHtml(u.username)}
        ${meta}
      </label>
      <input type="number" class="inv-stocks-qty" data-user-id="${u.id}"
             value="${s?.quantity ?? 0}" min="0" max="9999"
             oninput="updateInvStocksTotal()"/>
    </div>`;
  }).join('');

  updateInvStocksTotal();
  document.getElementById('modal-inv-stocks').style.display = 'flex';
}

function updateInvStocksTotal() {
  const inputs = document.querySelectorAll('.inv-stocks-qty');
  const total = [...inputs].reduce((sum, el) => sum + (parseInt(el.value) || 0), 0);
  document.getElementById('inv-stocks-total-val').textContent = total;
}

document.getElementById('cancel-inv-stocks').addEventListener('click', () => {
  document.getElementById('modal-inv-stocks').style.display = 'none';
});

document.getElementById('confirm-inv-stocks').addEventListener('click', async () => {
  const itemId = document.getElementById('inv-stocks-item-id').value;
  const inputs = document.querySelectorAll('.inv-stocks-qty');
  const stocks = [...inputs].map(el => ({
    user_id:  parseInt(el.dataset.userId),
    quantity: parseInt(el.value) || 0,
  }));
  const r = await api.put(`/api/inventory/${itemId}/stocks`, { stocks });
  if (r?.error) return alert(r.error);
  document.getElementById('modal-inv-stocks').style.display = 'none';
  await loadInventory();
  renderInventory();
});

// ── Mouvements de stock ───────────────────────────────────────────────────────

async function openMovementsModal(itemId, itemName) {
  document.getElementById('movements-title').textContent = `Historique — ${itemName}`;
  document.getElementById('movements-list').innerHTML = '<p style="color:var(--text2);font-size:.85rem">Chargement…</p>';
  document.getElementById('modal-movements').style.display = 'flex';
  const movements = await api.get(`/api/inventory/${itemId}/movements`) || [];
  const el = document.getElementById('movements-list');
  if (movements.length === 0) {
    el.innerHTML = '<p style="color:var(--text2);font-size:.85rem">Aucun mouvement enregistré.</p>';
    return;
  }
  el.innerHTML = movements.map(m => {
    const sign = m.delta > 0 ? '+' : '';
    const cls  = m.delta > 0 ? 'mv-plus' : 'mv-minus';
    const date = new Date(m.created_at + 'Z').toLocaleString('fr-FR');
    return `<div class="mv-row">
      <span class="mv-delta ${cls}">${sign}${m.delta}</span>
      <span class="mv-after">→ ${m.qty_after}</span>
      <span class="mv-user">${escapeHtml(m.user_name || '—')}</span>
      <span class="mv-date">${date}</span>
    </div>`;
  }).join('');
}

document.getElementById('close-movements').addEventListener('click', () => {
  document.getElementById('modal-movements').style.display = 'none';
});

// ── Discord Notify toggle ─────────────────────────────────────────────────────

let discordNotifyEnabled = true;

function initNotifyToggle(user) {
  discordNotifyEnabled = user.discord_notify !== 0;
  const btn = document.getElementById('btn-discord-notify');
  if (!btn) return;
  // Seuls les vrais comptes Discord peuvent toggle
  const isRealUser = user.discord_id && user.discord_id !== '__admin__' && user.discord_id !== 'local';
  if (!isRealUser) { btn.style.display = 'none'; return; }
  updateNotifyBtn();
  btn.addEventListener('click', async () => {
    discordNotifyEnabled = !discordNotifyEnabled;
    await api.patch('/api/users/me/notify', { discord_notify: discordNotifyEnabled });
    updateNotifyBtn();
  });
}

function updateNotifyBtn() {
  const btn = document.getElementById('btn-discord-notify');
  if (!btn) return;
  btn.textContent = discordNotifyEnabled ? '🔔' : '🔕';
  btn.title = discordNotifyEnabled ? 'Notifications Discord activées (cliquer pour désactiver)' : 'Notifications Discord désactivées (cliquer pour activer)';
  btn.classList.toggle('notify-off', !discordNotifyEnabled);
}

// ── Contrats ──────────────────────────────────────────────────────────────────

let contracts = [];
let currentContractDetailId = null;

async function loadContracts() {
  contracts = await api.get('/api/contracts') || [];
}

function renderContracts() {
  const el = document.getElementById('contracts-list');
  if (!el) return;
  if (contracts.length === 0) {
    el.innerHTML = '<p style="color:var(--text2);padding:24px">Aucun contrat. Crée-en un avec le bouton ci-dessus.</p>';
    return;
  }
  const active = contracts.filter(c => c.status === 'active');
  const closed = contracts.filter(c => c.status === 'closed');
  function renderGroup(list, title) {
    if (list.length === 0) return '';
    return `<div class="contracts-group">
      <div class="contracts-group-title">${title}</div>
      ${list.map(renderContractRow).join('')}
    </div>`;
  }
  el.innerHTML = renderGroup(active, 'En cours') + renderGroup(closed, 'Clôturés');
}

function renderContractRow(c) {
  const progress = c.total_value > 0 ? Math.round((c.delivered_value / c.total_value) * 100) : 0;
  const deadline = c.deadline ? new Date(c.deadline).toLocaleDateString('fr-FR') : '—';
  const isClosed = c.status === 'closed';
  const totalFmt = c.total_value ? `$${c.total_value.toLocaleString('fr-FR')}` : '—';
  const delivFmt = c.delivered_value ? `$${c.delivered_value.toLocaleString('fr-FR')}` : '$0';
  return `<div class="contract-row${isClosed ? ' contract-closed' : ''}">
    <div class="contract-row-main">
      <div class="contract-row-info">
        <span class="contract-name">${escapeHtml(c.name)}</span>
        ${c.client ? `<span class="contract-client">👤 ${escapeHtml(c.client)}</span>` : ''}
        <span class="contract-deadline">📅 ${deadline}</span>
        <span class="contract-lines-count">${c.line_count} ligne${c.line_count !== 1 ? 's' : ''}</span>
      </div>
      <div class="contract-row-money">
        <span class="contract-money-delivered">${delivFmt}</span>
        <span class="contract-money-sep">/</span>
        <span class="contract-money-total">${totalFmt}</span>
      </div>
    </div>
    ${c.total_value > 0 ? `<div class="contract-progress-bar"><div class="contract-progress-fill" style="width:${progress}%"></div></div>` : ''}
    <div class="contract-row-actions">
      <button class="btn-secondary btn-sm" onclick="openContractDetail(${c.id})">Détails</button>
      <button class="btn-secondary btn-sm" onclick="openEditContractModal(${c.id})" title="Modifier">✏️</button>
      <button class="btn-secondary btn-sm" onclick="toggleContractStatus(${c.id})">${isClosed ? '🔓 Rouvrir' : '🔒 Clôturer'}</button>
      <button class="btn-icon danger" onclick="deleteContract(${c.id})" title="Supprimer">🗑️</button>
    </div>
    ${c.notes ? `<div class="contract-notes">${escapeHtml(c.notes)}</div>` : ''}
  </div>`;
}

document.getElementById('btn-add-contract').addEventListener('click', () => {
  document.getElementById('contract-modal-title').textContent = 'Nouveau contrat';
  document.getElementById('c-id').value = '';
  document.getElementById('c-name').value = '';
  document.getElementById('c-client').value = '';
  document.getElementById('c-deadline').value = '';
  document.getElementById('c-notes').value = '';
  document.getElementById('modal-contract').style.display = 'flex';
});

function openEditContractModal(id) {
  const c = contracts.find(x => x.id === id);
  if (!c) return;
  document.getElementById('contract-modal-title').textContent = 'Modifier le contrat';
  document.getElementById('c-id').value = c.id;
  document.getElementById('c-name').value = c.name;
  document.getElementById('c-client').value = c.client || '';
  document.getElementById('c-deadline').value = c.deadline ? c.deadline.slice(0, 10) : '';
  document.getElementById('c-notes').value = c.notes || '';
  document.getElementById('modal-contract').style.display = 'flex';
}

document.getElementById('cancel-contract').addEventListener('click', () => {
  document.getElementById('modal-contract').style.display = 'none';
});

document.getElementById('confirm-contract').addEventListener('click', async () => {
  const id       = document.getElementById('c-id').value;
  const name     = document.getElementById('c-name').value.trim();
  const client   = document.getElementById('c-client').value.trim();
  const deadline = document.getElementById('c-deadline').value;
  const notes    = document.getElementById('c-notes').value.trim();
  if (!name) return alert('Nom requis.');
  const r = id
    ? await api.put(`/api/contracts/${id}`, { name, client, deadline, notes })
    : await api.post('/api/contracts', { name, client, deadline, notes });
  if (r?.error) return alert(r.error);
  document.getElementById('modal-contract').style.display = 'none';
  await loadContracts();
  renderContracts();
});

async function toggleContractStatus(id) {
  const r = await api.post(`/api/contracts/${id}/toggle-status`, {});
  if (r?.error) return alert(r.error);
  await loadContracts();
  renderContracts();
}

async function deleteContract(id) {
  if (!confirm('Supprimer ce contrat et toutes ses lignes ?')) return;
  const r = await api.delete(`/api/contracts/${id}`);
  if (r?.error) return alert(r.error);
  await loadContracts();
  renderContracts();
}

// ── Détail contrat ────────────────────────────────────────────────────────────

async function openContractDetail(id) {
  currentContractDetailId = id;
  const c = contracts.find(x => x.id === id);
  if (!c) return;
  document.getElementById('contract-detail-title').textContent = escapeHtml(c.name);
  const statusLabel = c.status === 'closed' ? '🔒 Clôturé' : '🟢 En cours';
  const deadline    = c.deadline ? new Date(c.deadline).toLocaleDateString('fr-FR') : '—';
  document.getElementById('contract-detail-meta').innerHTML = `
    <span>${statusLabel}</span>${c.client ? ` · <span>👤 ${escapeHtml(c.client)}</span>` : ''} · <span>📅 ${deadline}</span>
  `;
  document.getElementById('modal-contract-detail').style.display = 'flex';
  await renderContractLines(id);
}

async function renderContractLines(contractId) {
  const lines = await api.get(`/api/contracts/${contractId}/lines`) || [];
  const el = document.getElementById('contract-lines-list');
  if (lines.length === 0) {
    el.innerHTML = '<p style="color:var(--text2);font-size:.85rem;padding:8px 0">Aucune ligne — ajoute-en une ci-dessous.</p>';
    return;
  }
  el.innerHTML = `<div class="cl-header">
    <span>Produit</span><span>Commandé</span><span>Livré</span><span>Prix/u</span><span>Total</span><span></span>
  </div>` + lines.map(l => {
    const total = l.qty_delivered * l.unit_price;
    return `<div class="cl-row">
      <span class="cl-product">${escapeHtml(l.product_name)}</span>
      <span><input type="number" class="cl-input" value="${l.qty_ordered}" min="0" onchange="updateContractLine(${contractId}, ${l.id}, 'qty_ordered', this.value, this)" data-field="qty_ordered"/></span>
      <span><input type="number" class="cl-input cl-delivered" value="${l.qty_delivered}" min="0" max="${l.qty_ordered}" onchange="updateContractLine(${contractId}, ${l.id}, 'qty_delivered', this.value, this)" data-field="qty_delivered"/></span>
      <span><input type="number" class="cl-input" value="${l.unit_price}" min="0" onchange="updateContractLine(${contractId}, ${l.id}, 'unit_price', this.value, this)" data-field="unit_price"/></span>
      <span class="cl-total" id="cl-total-${l.id}">$${total.toLocaleString('fr-FR')}</span>
      <button class="btn-icon danger" onclick="deleteContractLine(${contractId}, ${l.id})" title="Supprimer">🗑️</button>
    </div>`;
  }).join('');
}

async function updateContractLine(contractId, lineId, field, value, inputEl) {
  const row = inputEl.closest('.cl-row');
  const inputs = row.querySelectorAll('.cl-input');
  const data = {
    product_name:  row.querySelector('.cl-product').textContent,
    qty_ordered:   parseInt(inputs[0].value) || 0,
    qty_delivered: parseInt(inputs[1].value) || 0,
    unit_price:    parseInt(inputs[2].value) || 0,
  };
  await api.put(`/api/contracts/${contractId}/lines/${lineId}`, data);
  const total = data.qty_delivered * data.unit_price;
  const totalEl = document.getElementById(`cl-total-${lineId}`);
  if (totalEl) totalEl.textContent = `$${total.toLocaleString('fr-FR')}`;
  await loadContracts();
  renderContracts();
}

async function deleteContractLine(contractId, lineId) {
  if (!confirm('Supprimer cette ligne ?')) return;
  await api.delete(`/api/contracts/${contractId}/lines/${lineId}`);
  await renderContractLines(contractId);
  await loadContracts();
  renderContracts();
}

document.getElementById('btn-add-contract-line').addEventListener('click', async () => {
  const product  = document.getElementById('cl-product').value.trim();
  const qty      = parseInt(document.getElementById('cl-qty').value) || 0;
  const price    = parseInt(document.getElementById('cl-price').value) || 0;
  if (!product) return alert('Produit requis.');
  const r = await api.post(`/api/contracts/${currentContractDetailId}/lines`, {
    product_name: product, qty_ordered: qty, unit_price: price,
  });
  if (r?.error) return alert(r.error);
  document.getElementById('cl-product').value = '';
  document.getElementById('cl-qty').value = '';
  document.getElementById('cl-price').value = '';
  await renderContractLines(currentContractDetailId);
  await loadContracts();
  renderContracts();
});

document.getElementById('close-contract-detail').addEventListener('click', () => {
  document.getElementById('modal-contract-detail').style.display = 'none';
});

// ── Boot ──────────────────────────────────────────────────────────────────────
(async () => {
  const user = await checkAuth();
  if (!user) return;
  await loadMerchandise();
  await loadPoints();
  await loadOrderItems();
  await loadOrders();
  await loadUsers();
  await loadInventory();
  await loadInvFavorites();
  await loadRecipes();
  await loadContracts();
  if (user.is_admin) await loadSettings();
  initNotifyToggle(user);
  initSocket();
})();

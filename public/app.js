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
  if (tab === 'map')    map.invalidateSize();
  if (tab === 'list')   renderList();
  if (tab === 'orders') renderOrders();
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
  const payload = { discord_notify_channel_id: document.getElementById('s-notify-channel-id').value.trim() };
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

// ── Auto-refresh 60s ──────────────────────────────────────────────────────────
setInterval(async () => {
  await loadPoints();
  if (document.querySelector('.leaflet-popup')) points.forEach(p => refreshPopup(p.id));
}, 60_000);

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

function renderOrders() {
  const tbody = document.getElementById('orders-body');
  if (!tbody) return;

  const pending = orders.filter(o => o.status === 'pending');
  const done    = orders.filter(o => o.status === 'done');
  const sorted  = [...pending, ...done];

  tbody.innerHTML = sorted.length === 0
    ? '<tr><td colspan="7" style="text-align:center;color:var(--text2);padding:24px">Aucune commande</td></tr>'
    : sorted.map(o => {
        const deadline = o.deadline
          ? new Date(o.deadline).toLocaleDateString('fr-FR')
          : '<span style="color:var(--text2)">—</span>';

        const assignees = o.assignees.map(u =>
          `<span class="assignee-tag">${escapeHtml(u.username)}</span>`
        ).join('');

        const statusBadge = o.status === 'done'
          ? '<span class="vis-badge shared">✓ Terminée</span>'
          : '<span class="vis-badge" style="background:rgba(230,126,34,.15);color:#e67e22;border-color:#e67e22">En cours</span>';

        const canAct = currentUser?.is_admin || o.created_by === currentUser?.id;
        const actions = o.status === 'pending'
          ? `<button class="btn-harvest" onclick="completeOrder(${o.id})">✓ Terminer</button>
             ${canAct ? `<button class="btn-edit" onclick="openEditOrderModal(${o.id})">✏️</button>
             <button class="btn-delete" onclick="deleteOrder(${o.id})">🗑️</button>` : ''}`
          : `${canAct ? `<button class="btn-delete" onclick="deleteOrder(${o.id})">🗑️</button>` : ''}`;

        return `<tr class="${o.status === 'done' ? 'order-done' : ''}">
          <td>${escapeHtml(o.item_name)}</td>
          <td>${o.quantity}</td>
          <td>${deadline}</td>
          <td>${assignees || '—'}</td>
          <td>${escapeHtml(o.created_by_name || '—')}</td>
          <td>${statusBadge}</td>
          <td class="actions-cell">${actions}</td>
        </tr>`;
      }).join('');
}

function renderOrderItemsList() {
  const el = document.getElementById('order-items-list');
  if (!el) return;
  el.innerHTML = orderItems.length === 0
    ? '<p style="color:var(--text2);font-size:.85rem;padding:8px 0">Aucun article — ajoute-en un ci-dessous.</p>'
    : orderItems.map(item => `
        <div class="order-item-row">
          <span>${escapeHtml(item.name)}</span>
          <div style="display:flex;gap:6px">
            <button class="btn-edit" onclick="openEditOrderItemModal(${item.id}, '${escapeHtml(item.name).replace(/'/g, "\\'")}')">✏️</button>
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
  container.innerHTML = allUsers.length === 0
    ? '<p style="color:var(--text2);font-size:.85rem">Aucun utilisateur.</p>'
    : allUsers.map(u => `
        <label class="assignee-checkbox">
          <input type="checkbox" value="${u.id}" ${selectedIds.includes(u.id) ? 'checked' : ''}/>
          ${escapeHtml(u.username)}
        </label>
      `).join('');
}

function openNewOrderModal() {
  document.getElementById('o-id').value = '';
  document.getElementById('order-modal-title').textContent = 'Nouvelle commande';
  document.getElementById('o-quantity').value = 1;
  document.getElementById('o-deadline').value = '';
  populateOrderItemSelect();
  populateAssigneeCheckboxes();
  document.getElementById('modal-order').style.display = 'flex';
}

function openEditOrderModal(id) {
  const o = orders.find(x => x.id === id);
  if (!o) return;
  document.getElementById('o-id').value = id;
  document.getElementById('order-modal-title').textContent = 'Modifier la commande';
  document.getElementById('o-quantity').value = o.quantity;
  document.getElementById('o-deadline').value = o.deadline ? o.deadline.slice(0, 10) : '';
  populateOrderItemSelect(o.item_id);
  populateAssigneeCheckboxes(o.assignees.map(u => u.id));
  document.getElementById('modal-order').style.display = 'flex';
}

function closeOrderModal() {
  document.getElementById('modal-order').style.display = 'none';
}

document.getElementById('btn-add-order').addEventListener('click', openNewOrderModal);
document.getElementById('cancel-order').addEventListener('click', closeOrderModal);

document.getElementById('confirm-order').addEventListener('click', async () => {
  const id       = document.getElementById('o-id').value;
  const item_id  = document.getElementById('o-item').value;
  const quantity = parseInt(document.getElementById('o-quantity').value) || 1;
  const deadline = document.getElementById('o-deadline').value || null;
  const user_ids = [...document.querySelectorAll('#o-assignees input[type=checkbox]:checked')]
    .map(cb => parseInt(cb.value));

  if (!item_id) return alert('Sélectionne un article.');
  if (user_ids.length === 0) return alert('Assigne la commande à au moins une personne.');

  const body = { item_id: parseInt(item_id), quantity, deadline, user_ids };
  const r = id
    ? await api.put(`/api/orders/${id}`, body)
    : await api.post('/api/orders', body);

  if (r?.error) return alert(r.error);
  closeOrderModal();
  await loadOrders();
  renderOrders();
});

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

function openEditOrderItemModal(id, currentName) {
  document.getElementById('oi-edit-id').value = id;
  document.getElementById('oi-edit-name').value = currentName;
  document.getElementById('modal-order-item-edit').style.display = 'flex';
}

document.getElementById('cancel-order-item-edit').addEventListener('click', () => {
  document.getElementById('modal-order-item-edit').style.display = 'none';
});

document.getElementById('confirm-order-item-edit').addEventListener('click', async () => {
  const id   = document.getElementById('oi-edit-id').value;
  const name = document.getElementById('oi-edit-name').value.trim();
  if (!name) return alert('Nom requis.');
  const r = await api.put(`/api/order-items/${id}`, { name });
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

// ── Boot ──────────────────────────────────────────────────────────────────────
(async () => {
  const user = await checkAuth();
  if (!user) return;
  await loadMerchandise();
  await loadPoints();
  await loadOrderItems();
  await loadOrders();
  await loadUsers();
  if (user.is_admin) await loadSettings();
})();

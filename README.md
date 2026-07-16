# GTA V — Drug Map Dashboard

Dashboard de gestion de plantations de drogue pour équipes GTA V Online.  
Carte interactive, notifications Discord, système perso/partagé.

## Fonctionnalités

- **Carte interactive** — Carte GTA V 4K avec marqueurs colorés et cercle de progression
- **Plants actifs** — Liste avec timer en direct, progression, et statut de récolte
- **Visibilité** — Plants partagés (équipe) ou personnels (privés)
- **Filtres** — Affichage par Tout / Équipe / Perso sur carte et liste
- **Notifications Discord** — Bot envoie un MP pour les plants perso, un message salon pour les plants partagés
- **Connexion Discord OAuth2** — Login via Discord, ou compte admin local
- **Marchandises** — Gestion des types de drogues (admin)
- **Multi-utilisateurs** — Chaque membre voit ses plants + ceux de l'équipe

## Stack

- **Backend** : Node.js + Express + SQLite (`better-sqlite3`)
- **Frontend** : Vanilla JS + Leaflet.js (carte `CRS.Simple`)
- **Auth** : Discord OAuth2 + session cookie (admin local possible)
- **Notifs** : Discord Bot API (MP pour perso, salon pour partagé)
- **Deploy** : Docker + docker-compose

## Installation

### Prérequis

- Docker + docker-compose
- Un bot Discord (token)
- Une application Discord OAuth2 (optionnel, pour login Discord)

### 1. Cloner le repo

```bash
git clone git@github.com:louisdchrf/zeeddashboard.git
cd zeeddashboard
```

### 2. Configurer l'environnement

```bash
cp .env.example .env
```

Éditer `.env` :

```env
SESSION_SECRET=une-chaine-secrete-longue
```

### 3. Déployer

```bash
./deploy.sh "Premier déploiement"
```

Le script build l'image Docker, démarre le conteneur, et pousse sur GitHub.

### 4. Première connexion

Ouvrir `http://localhost:3000`, créer le compte admin (username + mot de passe).

### 5. Configurer dans Paramètres (onglet admin)

| Paramètre | Description |
|---|---|
| Discord Client ID / Secret | Pour le login OAuth2 Discord |
| Discord Bot Token | Pour les notifications DM / salon |
| Discord Channel ID | Salon où envoyer les notifs partagées |
| Discord Guild ID | Serveur Discord requis pour accéder |

## Utilisation

### Ajouter un plant

- **Depuis la carte** : cliquer sur la carte → remplir le formulaire
- **Depuis la liste** : bouton `+ Ajouter` en haut de l'onglet Plants actifs

### Récolter / Supprimer

- Depuis la carte : clic sur le marqueur → popup → Récolter ou Supprimer
- Depuis la liste : boutons en fin de ligne

### Visibilité

- **Partagé** : visible par toute l'équipe, n'importe qui peut récolter
- **Personnel** : visible seulement par toi, notification en DM Discord

## Déploiement

```bash
./deploy.sh "Description des changements"
```

Le script :
1. Génère un numéro de version (`AA.MMJJ.HHMM`)
2. Met à jour `CHANGELOG.md`
3. Commit + push sur GitHub
4. Rebuild l'image Docker
5. Redémarre le conteneur

## Structure

```
.
├── server.js          # API Express + auth + notifications
├── db.js              # Schéma SQLite + migrations
├── public/
│   ├── index.html     # UI (single page)
│   ├── app.js         # Logique frontend
│   ├── style.css      # Styles
│   └── images/
│       └── map_4k.png # Carte GTA V 4096×4096
├── docker-compose.yml
├── Dockerfile
├── deploy.sh          # Script de déploiement
└── data/              # Base SQLite (monté en volume, ignoré par git)
```

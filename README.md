# 🎬 Rainbow Cinema

Ton cinéma personnel en PWA (application installable) : vidéos Archive.org, radio web en fond sonore, diffusion Chromecast / AirPlay, fonctionnement hors-ligne. **Vanilla JS, zéro dépendance, zéro build.**

**▶ Démo : https://mikefri-studio.github.io/player/**

## ✨ Fonctionnalités

- **Bibliothèque** : `videos.json` + synchronisation automatique d'un compte Archive.org, recherche (`Ctrl+K`), recherche vocale, favoris, reprise de lecture
- **Lecteur** : buffer anti-saccades, retry avec URLs de secours, mini-player, Picture-in-Picture natif (`I`), mode cinéma + ambilight, boucle A/B, vitesse de lecture, notes horodatées, glisser-déposer de fichiers locaux
- **Diffusion** : Chromecast, AirPlay, Remote Playback API
- **Radio** : stations + flux personnalisés, mix vidéo/radio, minuteur d'arrêt
- **PWA** : hors-ligne (service worker), installable, MediaSession (écran verrouillé), wake lock, liens de partage horodatés (`?v=…&t=…`)
- **Données** : stats de visionnage, export/import JSON, 100 % local (localStorage + IndexedDB)

## 🚀 Installation

Ouvre la démo dans Chrome / Edge / Safari → « Installer l'application » / « Ajouter à l'écran d'accueil ».

## ⌨️ Raccourcis clavier

| Touche | Action | Touche | Action |
|---|---|---|---|
| Espace | Lecture / pause | `M` | Muet |
| `←` / `→` | ±10 secondes | `N` | Notes |
| `↑` / `↓` | Volume vidéo | `R` | Vidéo aléatoire |
| `F` | Plein écran | `S` | Vitesse de lecture |
| `I` | Picture-in-Picture | `L` | Boucle A/B |
| `C` | Mode cinéma | `Ctrl+K` | Recherche |
| `K` | Caster | `Alt+flèches` | Naviguer dans la grille |
| `P` | Radio | `Échap` | Fermer les panneaux |

## 📁 Structure

| Fichier | Rôle |
|---|---|
| `index.html` | Squelette de la page |
| `style.css` | Styles |
| `app.js` | Toute la logique |
| `sw.js` | Service worker (hors-ligne + mises à jour) |
| `manifest.webmanifest` + `icons/` | Installation PWA |
| `videos.json` | Bibliothèque manuelle |
| `admin.html` | 🛠 Éditeur de bibliothèque (génère `videos.json`) |
| `convertisseur.html` | 🎨 Générateur d'icônes PWA |

## 🎞 Ajouter des vidéos

Le plus simple : ouvre **`admin.html`** (éditeur + explorateur Archive.org), puis uploade le `videos.json` généré dans le repo. Une GitHub Action valide le fichier à chaque push.

Format manuel :

```json
[
  {
    "titre": "Mon film",
    "video": "https://archive.org/download/identifiant/film.mp4",
    "vignette": "https://exemple.com/image.jpg"
  }
]
```

- `video` : obligatoire, en **https** (http est bloqué sur GitHub Pages)
- `vignette` : optionnelle — sinon elle est générée automatiquement depuis la vidéo

## 🛠 Développement

```bash
python3 -m http.server 8080
# → http://localhost:8080
```

Ou édite directement dans le navigateur : https://github.dev/mikefri-studio/player

## ⚙️ Stratégie hors-ligne (`sw.js`)

- **Navigation** : réseau d'abord, repli cache
- **Même origine** : stale-while-revalidate
- **Vignettes Archive.org** : cache d'abord (400 max)
- **Vidéos / radio** : jamais interceptées (streaming Range préservé)
- **Mises à jour** : bandeau « Nouvelle version disponible » → rechargement à la demande

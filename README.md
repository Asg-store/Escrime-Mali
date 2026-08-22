# Escrime Mali — Application de compétition PUBG Mobile

Application web complète (joueurs + administration) connectée à Firebase.
Thème tactique esports, icônes SVG animées (aucun emoji), interface en français,
optimisée mobile.

## Fichiers

Tout (HTML + CSS + JavaScript) est regroupé dans **deux fichiers autonomes** :

```
escrime-mali/
├── index.html            → Application joueur (CSS + JS inclus)
├── admin.html            → Console d'administration (CSS + JS inclus)
├── sw.js                 → (Optionnel) améliore l'installation hors-ligne
├── database.rules.json   → Règles Realtime Database
└── storage.rules         → Règles Storage
```

Chaque fichier HTML contient déjà le thème, les icônes, la logique et le
nécessaire pour installer l'application (PWA). Seul Firebase est chargé depuis
Internet (SDK officiel `gstatic.com`).

## Installer / télécharger l'application

L'application est une **PWA** : elle peut être installée sur le téléphone ou
l'ordinateur, comme une application native.

- **Joueur** : ouvrez l'onglet **Profil** → bouton **Installer l'application**.
- **Admin** : bouton **Installer l'application** dans le menu latéral.
- Sur **Android/Chrome/Edge** : une vraie invite d'installation s'affiche.
- Sur **iPhone (Safari)** : bouton **Partager** → **Sur l'écran d'accueil**
  (des instructions apparaissent automatiquement).

> L'installation exige un hébergement en **HTTPS** (voir ci-dessous). En local
> `file://`, le bouton affiche les instructions mais l'installation réelle
> nécessite une URL `https://`.

## Configuration Firebase (une seule fois)

Dans la console Firebase du projet **mali-pubg** :

1. **Authentication → Sign-in method** : activez **E-mail/Mot de passe** et **Google**.
   Dans *Settings → Authorized domains*, ajoutez le domaine où vous hébergez le site.
2. **Realtime Database** : créez la base (région Europe/US), puis dans l'onglet
   **Rules**, collez le contenu de `database.rules.json` et publiez.
3. **Storage** : activez-le, puis collez le contenu de `storage.rules` dans ses règles.

### Se connecter en tant qu'administrateur

Par sécurité, la console est réservée aux comptes marqués `role: "admin"`.
Pour transformer votre compte en administrateur (à faire **une seule fois**) :

1. Créez votre compte depuis `index.html` (connexion Google ou e-mail).
2. Ouvrez la **console Firebase** → **Realtime Database**.
3. Dépliez le nœud `users`. Repérez votre compte (par l'e-mail affiché) et notez
   la clé au-dessus (votre **UID**).
4. Sous `users / VOTRE_UID`, ajoutez un champ : nom `role`, valeur `admin`.
5. Ouvrez `admin.html` et rechargez : la console s'ouvre.

Ensuite, vous pouvez nommer d'autres administrateurs directement depuis
*Console → Joueurs* (bouton **Rendre admin**).

> Alternative : mettez votre e-mail dans `ADMIN_EMAILS` (recherchez ce mot dans
> `index.html` et `admin.html`). Cela ouvre la console, mais pour **enregistrer**
> des données il faut tout de même le rôle `admin` dans la base (étape ci-dessus).

## Hébergement

N'importe quel hébergement statique convient (Firebase Hosting, Netlify, Vercel,
GitHub Pages…). Avec Firebase Hosting :

```bash
npm install -g firebase-tools
firebase login
firebase init hosting     # dossier public = ce dossier ; page principale = index.html
firebase deploy
```

Les deux fichiers `index.html` et `admin.html` suffisent (plus les deux fichiers
de règles à coller dans la console Firebase).

> À ouvrir via `http(s)://` — pas en `file://` (les modules ES et Firebase
> l'exigent).

## Correspondance avec les fonctionnalités demandées

| Demande | Où |
|---|---|
| Nom de l'app **Escrime Mali** | Partout (barre, écran de connexion) |
| Connexion Google **ou** e-mail | Écran d'authentification |
| Nom du joueur + ID joueur | Inscription / complément de profil |
| Admin fixe un **prix** ou **inscription gratuite** | Console → Inscriptions & prix |
| Équipe **1 → 4** joueurs | Détail d'un match (création / rejoindre) |
| Match **max 100 joueurs**, **max 25 équipes** | Paramètres du match |
| Écran **Shorts** (façon TikTok), photo & vidéo | Onglet Shorts |
| Chat vocal + texte + photo + vidéo | Onglet Chat |
| **Messages privés** joueur ↔ joueur | Onglet Privé |
| **Support** admin | Onglet Support / Console → Support |
| Qualifié / non qualifié / 1ʳᵉ, 2ᵉ, 3ᵉ place | Console → Qualifications |
| Écran de **qualification** | Profil (Mon parcours) + détail match |
| **Toutes les infos** d'un match | Détail du match |
| Options tournoi PUBG (carte, mode, prix…) | Console → Matchs |
| Admin **ferme les inscriptions** | Console → Matchs (bouton) |
| Annonces date/heure + **notifications** | Console → Annonces / Onglet Notifications |
| Icônes **CSS/SVG** animées, sans emoji | Intégrées dans les fichiers |
| Options **séparées** | Onglets & pages distincts |
| **Télécharger l'application** | Profil (joueur) / Menu (admin) — PWA |
| Tout en **2 fichiers** (HTML+CSS+JS) | `index.html` & `admin.html` |

## Notes techniques

- **Chat vocal** = messages vocaux enregistrés (micro) puis envoyés. Un appel vocal
  en direct exigerait un serveur de signalisation WebRTC (hors application statique).
- **Notifications** = notifications dans l'app + notifications navigateur quand
  l'app est ouverte. Pour des notifications *push* même app fermée, ajoutez Firebase
  Cloud Messaging (service worker + clé VAPID).
- **Paiement** des inscriptions payantes : géré hors ligne ; l'admin valide le
  statut (« En attente » / « Payé ») dans *Console → Qualifications*.

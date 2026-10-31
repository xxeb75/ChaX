# ChaX

Une messagerie qui marche là où il n'y a plus de réseau.

ChaX envoie vos messages de téléphone en téléphone, en Bluetooth. Pas de compte, pas de serveur, chiffrement de bout en bout. Chaque appareil relaie les messages des autres sur plusieurs sauts, et garde ceux dont le destinataire est absent jusqu'à le croiser.

**Page de présentation : https://xxeb75.github.io/ChaX/**

> État : **version de test** (0.3.x). L'APK est signé avec une clé de développement, le protocole peut encore changer, et il n'a pas fait l'objet d'un audit de sécurité. À essayer entre proches, pas à confier à ce qui est vital.

## Télécharger

Android 7 ou plus : [dernière version](https://github.com/xxeb75/ChaX/releases/latest), fichier `ChaX-<version>.apk`.

1. Téléchargez l'APK sur le téléphone et ouvrez-le. Android demande d'autoriser l'installation depuis votre navigateur : c'est normal hors Play Store.
2. Lancez ChaX et choisissez un pseudo.
3. Pour écrire en privé à quelqu'un, il faut d'abord l'accepter ou le vérifier (voir plus bas).

L'app prévient quand une nouvelle version est disponible (vérification au lancement, six heures au plus entre deux, désactivable dans les paramètres). Une version Windows existe en test, sans être distribuée pour l'instant. Pas d'iPhone.

## Ce que ça fait

- **Mesh Bluetooth LE multi-sauts :** un message traverse plusieurs téléphones pour atteindre quelqu'un hors de votre portée directe.
- **Livraison différée :** si le destinataire est absent, un téléphone voisin garde le message chiffré et le lui porte à la rencontre.
- **Chiffrement de bout en bout :** double ratchet pour les messages privés, paquets signés, aucune clé sur un serveur.
- **Honnête sur l'état :** chaque message est « en attente d'un voisin », « en transit », « remis » ou « lu ».
- **Alertes prioritaires :** diffusées à tout le mesh, même à ceux qui arriveront plus tard.
- **Photos et fichiers :** jusqu'à 2 Mo, fragmentés pour passer en Bluetooth.
- **Toujours actif sur Android :** le mesh continue app balayée et écran éteint, avec notifications.
- **Internet en secours, avec votre accord :** le Bluetooth est toujours privilégié. Si personne n'est à portée depuis une trentaine de secondes, ChaX peut passer par des relais Nostr publics, après vous avoir demandé la permission la première fois. Le Bluetooth reprend dès que des voisins reviennent. Trois modes dans les paramètres : automatique, toujours actif, désactivé.

## Contacts : accepter et vérifier

Les messages privés sont réservés aux contacts que vous avez choisis ; ceux des inconnus sont ignorés sans accusé de réception. Deux niveaux :

- **Vérifié ✓ :** vous avez scanné son code (QR) en personne, ou collé un code reçu par un canal sûr. C'est la seule façon d'être certain de parler à la bonne personne.
- **Accepté :** vous l'autorisez à vous écrire sans scanner son code. Pratique, mais rien ne prouve que c'est bien elle. Vous pouvez la vérifier plus tard.

Le canal public et les alertes restent ouverts à tous, et ne sont pas confidentiels.

## Ce que voient les relais Internet

Si vous autorisez le secours Internet, les relais Nostr voient votre adresse IP, l'heure et la taille des paquets. Vos messages privés restent chiffrés ; ceux du canal public sont lisibles par n'importe qui sur ces relais. La vérification de mises à jour interroge `api.github.com`, qui voit l'adresse IP du téléphone. Rien d'autre n'est transmis.

## Limites connues

- Le premier message d'un contact pas encore accepté n'est pas déchiffré : il doit le renvoyer une fois accepté.
- Pas de synchronisation entre plusieurs appareils, pas d'appels.
- Les portées et la fiabilité dépendent du Bluetooth des téléphones.
- Le code n'a pas été audité.

## Organisation du dépôt

Monorepo TypeScript, Java et C#.

| Dossier | Rôle |
|---|---|
| `packages/core` | Le protocole : identité, paquets, chiffrement, routage, store-and-forward, transports. Tests avec Vitest. |
| `packages/chat-web` | L'interface de l'app (Vite), partagée entre Android, Windows et navigateur. |
| `packages/android` | Coque Capacitor : moteur Bluetooth, service d'arrière-plan, notifications. |
| `packages/windows` | App de bureau .NET 8 (WebView2) avec Bluetooth via WinRT. En test. |
| `packages/sim-web` | Simulateur de mesh dans le navigateur. |
| `packages/relay` | Petit relais WebSocket de démonstration pour tester le transport Internet. |
| `site` | La page de présentation, publiée sur GitHub Pages. |
| `docs` | [Spécification](docs/SPEC.md) et [procédure de publication](docs/RELEASING.md). |

## Développer

Prérequis : Node.js ; JDK 21 et le SDK Android pour l'APK ; le SDK .NET 8 pour Windows.

```bash
# tests du protocole
cd packages/core && npm install && npm test

# l'interface dans un navigateur
cd packages/chat-web && npm install && npm run dev

# l'APK de test
cd packages/chat-web && npx vite build
cd ../android && npx cap sync android
cd android && ./gradlew assembleDebug
```

La version a une seule source : `packages/chat-web/package.json`. Voir [docs/RELEASING.md](docs/RELEASING.md) pour publier un APK (signature, Release GitHub).

## Licence

Aucune licence n'a été choisie pour l'instant : par défaut, tous droits réservés.

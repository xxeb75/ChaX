# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Tout public, dans la vie privée : des personnes qui veulent écrire à leurs proches ou aux gens autour d'elles sans compte, sans serveur et sans réseau mobile. Elles utilisent ChaX sur un téléphone Android (app Capacitor), sur un PC Windows (app de bureau) ou dans un navigateur, souvent dans la poche, écran éteint pour le téléphone. Audience plus ciblée (équipes de terrain, événements, zones sans couverture) non confirmée comme cible principale. Les premiers testeurs sont des proches sollicités directement par l'auteur.

## Product Purpose

ChaX est une messagerie mesh pair à pair en Bluetooth LE, dans l'esprit de Bitchat, mais plus fiable et plus sûre : chaque appareil relaie les messages des autres sur plusieurs sauts. Le succès, c'est un message qui arrive, est chiffré, et dont l'émetteur sait s'il est en transit, remis ou lu, même quand l'app est fermée.

## Positioning

Quatre points que le produit tient ensemble (confirmés) :
- fiabilité du mesh : store-and-forward, accusés remis/lu, reprise après coupure Bluetooth, fragmentation pour photos et fichiers ;
- chiffrement fort : double ratchet pour les messages privés, paquets signés, aucune clé sur un serveur ;
- toujours actif : le mesh tourne app balayée et écran éteint, avec notifications (sur Android) ;
- alertes prioritaires diffusées à tout le mesh.

Principe de portée (confirmé) : le Bluetooth est toujours privilégié. Quand aucun pair n'est détecté depuis une trentaine de secondes, l'app bascule sur internet (relais Nostr), puis revient au Bluetooth quand des voisins sont à portée (réalisé : modes automatique, toujours actif, désactivé). Le basculement automatique demande l'accord de l'utilisateur la première fois que les relais seraient nécessaires (fenêtre qui explique ce qu'ils voient ; « plus tard » redemande après dix minutes, « non » garde le Bluetooth seul et reste modifiable dans les paramètres ; le mode « toujours actif » vaut accord).

## Operating Context

Spec dans `docs/SPEC.md`. Monorepo TypeScript : `packages/core` (protocole, transport Nostr), `chat-web` (interface), `sim-web`, `relay` (pont WebSocket optionnel), `android` (Capacitor, BLE natif, service de premier plan avec nœud JS sans interface), `windows` (.NET 8, WebView2, BLE WinRT en périphérique seul). Testé sur POCO, Pixel 8 et un PC Windows. Conversations : public, alertes, privées. Une conversation privée peut être supprimée (elle efface aussi la vérification du contact) ; le public et les alertes ne peuvent pas l'être. La liste sépare les contacts et conversations des inconnus vus sur l'air, regroupés sous « autour de vous ». Réglages (connexion Bluetooth/internet, relais, mise à jour) derrière un engrenage en haut à droite ; deux pictos non cliquables indiquent l'état du Bluetooth et d'internet.

Distribution des versions de test : Releases GitHub publiques de `xxeb75/ChaX` (APK). L'app vérifie toutes les six heures au plus s'il existe une version plus récente, désactivable ; une fenêtre au lancement et un bandeau mènent au téléchargement. Numéro de version unique dans `packages/chat-web/package.json`, à incrémenter à chaque APK distribué.

## Capabilities and Constraints

- Aucun serveur ni compte requis (confirmé). Le relais WebSocket est un pont optionnel, jamais une dépendance. Le repli par relais Nostr publics et la vérification de version sur GitHub (Android) contactent des serveurs tiers et leur révèlent l'adresse IP ; ils doivent rester compréhensibles et maîtrisables par l'utilisateur. Le basculement automatique demande un accord préalable, une fois.
- Interface et textes en français (usage observé, non reconfirmé).
- Plateformes prises en charge (confirmé) : Android, Windows, navigateur ; pas d'iOS pour l'instant (observé). Sur Windows, le PC est périphérique Bluetooth seulement (deux PC ne se voient pas en Bluetooth) et le mesh ne tourne que fenêtre ouverte ; le navigateur n'a pas de Bluetooth et passe par le repli internet.
- Règle de test, provisoire (confirmée comme telle) : les messages privés sont réservés aux contacts vérifiés en personne (code collé ou scanné) ; les messages directs d'un inconnu sont ignorés sans accusé, le canal public reste ouvert à tous. À reconsidérer : un premier contact moins lourd.
- Limites connues : le premier message d'une conversation privée n'a pas la confidentialité persistante ; pièces jointes limitées à 2 Mo ; test à 3 sauts réels non fait ; le canal public est lisible de tous sur les relais Nostr.

## Brand Commitments

Brief visuel : le langage graphique de l'application AgGr (`D:\PROJETS\AgGr`), demandé par l'utilisateur. Il est tenu par DESIGN/tokens existants dans `packages/chat-web`, non redéfini ici. Le logo est un chat stylisé, ambre.

## Evidence on Hand

Aucun témoignage, client ni benchmark : ne rien en inventer. Une critique d'interface archivée existe dans `.impeccable/critique/`.

## Product Principles

1. Fonctionner sans infrastructure : aucune dépendance obligatoire à un serveur ou un compte ; tout recours à internet est un repli, jamais le chemin principal.
2. Dire la vérité sur l'état d'un message : en transit, remis ou lu, jamais plus.
3. Les alertes et messages privés passent avant le bruit du canal public.
4. Le mesh continue quand l'app est fermée ; l'utilisateur n'a rien à entretenir.
5. La sécurité ne demande aucune action : chiffrement par défaut.

## Accessibility & Inclusion

Aucun standard imposé établi. Usage en mobilité, parfois en conditions difficiles : lisibilité et cibles tactiles confortables.

# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Tout public, dans la vie privée : des personnes qui veulent écrire à leurs proches ou aux gens autour d'elles sans compte, sans serveur et sans réseau mobile. Elles utilisent ChaX sur un téléphone Android (app Capacitor) ou dans un navigateur, souvent dans la poche, écran éteint. Audience plus ciblée (équipes de terrain, événements, zones sans couverture) non confirmée comme cible principale.

## Product Purpose

ChaX est une messagerie mesh pair à pair en Bluetooth LE, dans l'esprit de Bitchat, mais plus fiable et plus sûre : chaque téléphone relaie les messages des autres sur plusieurs sauts. Le succès, c'est un message qui arrive, est chiffré, et dont l'émetteur sait s'il est en transit, remis ou lu, même quand l'app est fermée.

## Positioning

Quatre points que le produit tient ensemble (confirmés) :
- fiabilité du mesh : store-and-forward, accusés remis/lu, reprise après coupure Bluetooth, fragmentation pour photos et fichiers ;
- chiffrement fort : double ratchet pour les messages privés, paquets signés, aucune clé sur un serveur ;
- toujours actif : le mesh tourne app balayée et écran éteint, avec notifications ;
- alertes prioritaires diffusées à tout le mesh.

## Operating Context

Spec dans `docs/SPEC.md`. Monorepo TypeScript : `packages/core` (protocole), `chat-web` (interface), `sim-web`, `relay` (pont WebSocket optionnel), `android` (Capacitor, BLE natif, service de premier plan avec nœud JS sans interface). Testé sur POCO et Pixel 8. Conversations : public, alertes, privées.

## Capabilities and Constraints

- Aucun serveur ni compte requis (confirmé). Le relais WebSocket est un pont optionnel, jamais une dépendance.
- Interface et textes en français (usage observé, non reconfirmé).
- Android et navigateur ; pas d'iOS pour l'instant (observé).
- Limites connues : le premier message d'une conversation privée n'a pas la confidentialité persistante ; pièces jointes limitées à 2 Mo ; test à 3 sauts réels non fait.

## Brand Commitments

Brief visuel : le langage graphique de l'application AgGr (`D:\PROJETS\AgGr`), demandé par l'utilisateur. Il est tenu par DESIGN/tokens existants dans `packages/chat-web`, non redéfini ici.

## Evidence on Hand

Aucun témoignage, client ni benchmark : ne rien en inventer. Une critique d'interface archivée existe dans `.impeccable/critique/`.

## Product Principles

1. Fonctionner sans infrastructure : aucune dépendance à un serveur ou un compte.
2. Dire la vérité sur l'état d'un message : en transit, remis ou lu, jamais plus.
3. Les alertes et messages privés passent avant le bruit du canal public.
4. Le mesh continue quand l'app est fermée ; l'utilisateur n'a rien à entretenir.
5. La sécurité ne demande aucune action : chiffrement par défaut.

## Accessibility & Inclusion

Aucun standard imposé établi. Usage en mobilité, parfois en conditions difficiles : lisibilité et cibles tactiles confortables.

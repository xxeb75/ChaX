# ChaX — Spécification v0.1 (brouillon)

Messagerie pair à pair, sans serveur ni numéro de téléphone, fonctionnant par réseau maillé local, avec livraison différée et ponts optionnels vers internet.

## 1. Objectifs

1. Fonctionner sans infrastructure (mesh multi-sauts).
2. Livrer aussi aux absents : store-and-forward chiffré.
3. Confidentialité forte : E2E, pas de métadonnées exploitables, pas de compte.
4. Transports interchangeables (BLE, Wi-Fi local, internet en option).
5. Médias (images, vocaux, fichiers) fragmentés.
6. Résistance au spam et aux nœuds malveillants.

Non-objectifs v1 : appels audio/vidéo, synchronisation multi-appareils, annuaire central.

## 2. Architecture en couches

```
UI (web/desktop d'abord, mobile ensuite)
Application   : salons, DM, médias, alertes
Sécurité      : identité, sessions E2E, signatures
Routage       : mesh, store-and-forward, dédoublonnage, TTL
Fragmentation : découpe/réassemblage selon le MTU du transport
Transport     : BLE | Wi-Fi local | WebSocket/Nostr | Sim (simulateur)
```

Chaque transport implémente une interface minimale : `send(peer, bytes)`, `broadcast(bytes)`, `onReceive`, `mtu`, `peers()`. Le simulateur est un transport comme un autre, ce qui permet de tester tout le reste sans matériel.

## 3. Identité

- Clé d'identité long terme : Ed25519 (signature). Clé de session : X25519.
- `peerId` = hash tronqué (8 octets) de la clé publique.
- Pseudo libre et non unique, affiché avec une empreinte courte.
- Vérification en personne par QR (échange de clés + empreinte) → niveau de confiance « vérifié ».
- Mode éphémère : rotation de clés et de peerId à chaque session.

## 4. Format de paquet

| Champ | Taille | Rôle |
|---|---|---|
| version | 1 | version du protocole |
| type | 1 | MSG, ACK, ANNOUNCE, FRAG, SYNC, ALERT |
| ttl | 1 | sauts restants (max 7) |
| flags | 1 | chiffré, signé, priorité, store-and-forward |
| msgId | 8 | identifiant unique (dédoublonnage) |
| timestamp | 8 | ms epoch |
| expiry | 4 | secondes de validité (store-and-forward) |
| src | 8 | peerId émetteur |
| dst | 8 | peerId destinataire, ou diffusion (0xFF…) |
| payloadLen | 2 | longueur |
| payload | n | contenu |
| signature | 64 | Ed25519 sur l'en-tête immuable + payload |

Le `ttl` est exclu de la signature pour pouvoir être décrémenté par les relais.

## 5. Chiffrement

- **DM (implémenté) :** double ratchet entre les identités X25519 longue durée (drapeau `RATCHET`), construit sur des primitives auditées (X25519, HKDF-SHA256, HMAC, ChaCha20-Poly1305). Pas de serveur de prékeys : la racine initiale mélange les deux clés statiques, la première étape DH ajoute l'éphémère de l'initiateur. Chaque réponse apporte une nouvelle clé de ratchet : à partir du deuxième aller-retour, les messages passés restent illisibles même si les clés longue durée sont volées (confidentialité persistante) et une session volée se referme au tour suivant. Le tout premier message n'est protégé que par les clés longue durée. Messages perdus ou déséquilibrés : clés sautées conservées (200 max). Initiations croisées : jusqu'à 4 sessions par pair, essayées de la plus récente à la plus ancienne. Les sessions se sérialisent (`exportSessions`) pour survivre à un redémarrage. Les anciens messages scellés (« sealed box ») restent lisibles.
- **Salons publics :** signés, non chiffrés.
- **Salons privés / groupes :** clé de groupe distribuée par DM, rotation à chaque départ de membre (version 1 : clé partagée ; version 2 : MLS).
- **Métadonnées :** `dst` peut être remplacé par un tag de routage dérivé (HMAC de la clé partagée + époque) afin que les relais ne sachent pas qui parle à qui. Rembourrage des tailles de paquets.

## 6. Routage mesh

- Inondation contrôlée : dédoublonnage par `msgId` (filtre de Bloom + cache LRU), décrémentation du TTL, délai aléatoire avant relais (suppression si on entend déjà un voisin relayer).
- Table de voisinage via ANNOUNCE périodiques (clé, pseudo, capacités, charge batterie).
- Route préférentielle quand la destination est connue (voisin à ≤ 3 sauts), sinon inondation.
- Limitation de débit par pair, avec score de réputation (§9).

## 7. Store-and-forward (innovation clé)

- Un paquet marqué `S&F` est conservé par les relais ayant de la place (quota, ex. 5 Mo, expiration max 72 h).
- À chaque nouvelle rencontre, deux nœuds échangent un SYNC : liste compacte (IBLT ou Bloom) des `msgId` détenus, puis transfert de ce qui manque.
- Le destinataire acquitte ; l'ACK se propage pour purger les copies.
- Les relais ne lisent rien : contenu scellé, et tag de routage opaque.
- Priorités : ALERT > DM > salon > média.

## 8. Médias

- Compression côté émetteur (images redimensionnées, voix en Opus).
- Fragmentation en blocs adaptés au MTU, adressés par hachage (hash du contenu), avec accusés par bloc et reprise.
- Le transport le plus rapide disponible est choisi (Wi-Fi local si présent, sinon BLE, avec avertissement sur la durée).
- Un média volumineux n'est pas diffusé dans tout le mesh : seul un aperçu l'est, le fichier complet est tiré à la demande.

## 9. Anti-abus

- Preuve de travail légère pour les diffusions publiques (paramétrable).
- Réputation locale : pénalité pour spam, signatures invalides, flood. Pas de réputation globale.
- Réseau de confiance : les contacts vérifiés bénéficient d'un quota et d'une priorité supérieurs.
- Blocage local, et signalement non partagé.

## 10. Fonctions nouvelles par rapport à Bitchat

| Fonction | Statut |
|---|---|
| Store-and-forward chiffré | v1 |
| Médias fragmentés | v1 |
| Transports multiples + pont internet | v1 (BLE + sim), v2 (Wi-Fi, Nostr) |
| Alertes d'urgence signées et géolocalisées | v1 |
| Carte du mesh en temps réel | v1 |
| Groupes chiffrés avec rotation de clés | v2 |
| Vérification QR + réseau de confiance | v1 |
| Mode économie d'énergie adaptatif | v2 |

## 11. Plan de réalisation

1. **Phase 0 (en cours) :** cette spécification.
2. **Phase 1 :** bibliothèque cœur en TypeScript (paquets, signature, chiffrement, routage, S&F) + transport simulé + tests.
3. **Phase 2 :** simulateur visuel web du mesh (déplacements, portée, pertes) pour valider les algorithmes.
4. **Phase 3 :** interface de chat web/desktop sur la même bibliothèque.
5. **Phase 4 :** transport BLE réel (Web Bluetooth ou application Android native).
6. **Suite :** vérification en personne : QR de l'empreinte à scanner face à face, badge « vérifié » dans la liste, avertissement si une empreinte inconnue reprend le pseudo d'un contact vérifié ; code court ajouté au pseudo pour distinguer les homonymes.
7. **Suite :** repli par internet, optionnel et désactivé par défaut : les mêmes paquets (déjà signés, chiffrés pour les messages privés) voyagent comme événements Nostr opaques (kind 4242, étiquette de sujet ou `p` du destinataire, expiration NIP-40, clé jetable par session) via des relais publics. Liens `net|lobby` et `net|p:<pair>`, distingués de `ble|…` dans l'interface (« à portée » / « par internet »). Les relais voient IP, heure et taille ; le canal public y est lisible de tous.

## 12. Questions ouvertes

- Nom du protocole et licence (domaine public comme Bitchat, ou MIT/Apache) ?
- Limite de taille des messages en v1 ?
- Noise + ratchet maison, ou bibliothèque auditée (libsodium, noise-protocol) ? Recommandation : bibliothèque.
- Plafond de rétention par défaut pour le S&F.

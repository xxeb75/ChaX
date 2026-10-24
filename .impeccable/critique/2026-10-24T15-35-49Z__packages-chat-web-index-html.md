---
target: chat-web interface
total_score: 28
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 2
target_identity: "file:D:\\PROJETS\\ChaX\\packages\\chat-web\\index.html"
target_fingerprint: "sha256:5e06120b0b2a6580bef63270a1d2e5b1261bdc4570e16df0d0f74ef7bc438e68"
target_path: "D:\\PROJETS\\ChaX\\packages\\chat-web\\index.html"
timestamp: 2026-10-24T15-35-49Z
slug: packages-chat-web-index-html
---
Method: dual-agent (A: revue de design · B: détecteur + mesures navigateur)

# Critique ChaX chat-web (28/40, Bon-)

Spécificité : forte, authentique (sonde de points, file de profondeur, dot leaders, alerte en bloc ivoire inversé). Détecteur : 0 finding, 0 anti-pattern navigateur.

| # | Heuristique | Score | Point clé |
|---|---|---|---|
| 1 | Visibilité de l'état | 3 | « remis » répété sous chaque message ; pas de progression d'envoi ; « réception » expire à 120 s sans état d'échec |
| 2 | Correspondance monde réel | 3 | « mesh » jargon ; « en transit » vs « en attente d'un voisin » subtil |
| 3 | Contrôle et liberté | 2 | pas d'annulation de transfert ni de suppression ; lightbox sans bouton fermer, retour Android non branché |
| 4 | Cohérence | 3 | très cohérent ; ses propres messages en gris atténué |
| 5 | Prévention des erreurs | 3 | envoi public et alerte sans confirmation |
| 6 | Reconnaissance | 2 | « + » muet, empreinte sans affordance, coller/déposer non signalé |
| 7 | Flexibilité | 3 | bon clavier ; ordre de la liste instable, pas de raccourci joindre |
| 8 | Minimalisme | 3 | esthétique forte ; flou et gris sur du texte courant |
| 9 | Récupération d'erreur | 2 | erreurs dans #flash masqué sur mobile en vue chat |
| 10 | Aide | 3 | état vide pédagogique ; rien sur l'empreinte ni les pièces jointes |
| | Total | 27-28/40 | |

Priority issues
- P0 Erreurs invisibles sur téléphone (#flash dans #side, masqué en vue chat) : « trop gros », « fichier introuvable », « clé inconnue ».
- P1 Transfert interrompu silencieux (ligne de réception qui disparaît à 120 s ; rien côté expéditeur).
- P1 Fichiers : nom tronqué (extension perdue), photos sans nom ni repère, vieilles photos pleine taille.
- P2 Messages « mine » en gris + flou, statut « remis » sous chaque message.
- P2 Affordances : « + » anonyme (40 px de large sur desktop), empreinte, collage.
- P3 Lightbox : bouton fermer, focus, retour Android.

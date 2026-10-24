---
target: lisibilité du fil de conversation
total_score: 23
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:D:\\PROJETS\\ChaX\\packages\\chat-web\\index.html"
target_fingerprint: "sha256:1cd51e6545e26eab59dc453ca2220b102809b11b80053ec2da8e0c916beda681"
target_path: "D:\\PROJETS\\ChaX\\packages\\chat-web\\index.html"
timestamp: 2026-10-24T19-00-19Z
slug: packages-chat-web-index-html
---
# Critique : lisibilité du fil de conversation (chat-web)

Method: dual-agent (A: a747219c · B: a8ac4343)

Score 23/40. Détecteur : 0 finding (index.html, overlay navigateur sur salon public vide).

Priorités :
- P1 Taille par rang (.msg.t0/.t1/.t2 = 20/16/13 px) : même voix, trois corps ; le fil reflow à chaque message. Fix : 16 px fixe, supprimer opacité/blur de profondeur.
- P1 Texte aligné à droite pour mes messages (.msg.mine text-align:right) : bord gauche en dents de scie. Fix : text-align left, côté par align-self + liseré.
- P1 Rythme : .msg.cont margin-top 0 / gap 2px, 10 px entre groupes. Fix : 4 px dans le groupe, ~20 px entre groupes, line-height 1.5.
- P2 Horodatage seulement au 1er message du groupe ; statut remis/lu seulement en fin de run : paraît aléatoire. Fix : une seule ligne de statut ancrée sous le dernier message envoyé, heure dans l'en-tête de groupe.
- P2 Composer mobile : champ 86 px (joindre 106 + envoyer 94), placeholder coupé. Fix : « + » seul 48x48, placeholder court, hint masqué en mobile.
Mineurs : URL non cliquable et coupée en milieu de mot, theirs en ivory plein trop lourd, dust-2 (~3:1) hors texte, méta en 11 px.

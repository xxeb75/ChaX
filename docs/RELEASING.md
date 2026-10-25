# Publier une version de test

L'app vérifie, au lancement (une fois par jour au plus, désactivable dans « internet › »), la dernière *Release* publique de `xxeb75/ChaX` sur GitHub. Si son numéro est plus grand que celui de l'APK installé, un bandeau « version X disponible · télécharger › » apparaît en haut de la liste.

## Numéro de version

Une seule source : `packages/chat-web/package.json` (`"version": "0.2.0"`). Vite l'injecte dans l'app, et Gradle en déduit `versionName` et `versionCode` (majeur × 10000 + mineur × 100 + correctif). **Incrémentez-la à chaque APK distribué**, sinon Android refuse la mise à jour et l'app ne voit rien de nouveau.

## Étapes

1. Monter la version dans `packages/chat-web/package.json`.
2. Construire l'APK :
   ```bash
   cd packages/chat-web && npx vite build
   cd ../android && npx cap sync android
   cd android && ./gradlew assembleDebug
   ```
   (`JAVA_HOME` sur le JDK 21.)
3. Renommer `app/build/outputs/apk/debug/app-debug.apk` en `ChaX-<version>.apk`.
4. Sur GitHub : *Releases → Draft a new release*, tag `v<version>` (ex. `v0.2.0`), joindre l'APK, **publier** (pas en brouillon, pas en pré-release : `releases/latest` les ignore).

## Signature

L'APK est signé avec la clé de debug de cette machine (`%USERPROFILE%\.android\debug.keystore`). Android n'installe une mise à jour que si la signature est identique : **sauvegardez ce fichier** et construisez toujours depuis la même clé, sinon les testeurs devront désinstaller (et perdront leur identité et leur historique).

## Confidentialité

La vérification envoie une requête à `api.github.com`, qui voit l'adresse IP du téléphone. Rien d'autre n'est transmis. Le service d'arrière-plan ne vérifie jamais.

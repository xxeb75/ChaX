# ChaX pour Windows

L'app web (`packages/chat-web`) dans une fenêtre WebView2, avec le Bluetooth Low Energy assuré par Windows (WinRT) derrière le même pont que sur Android : `BleEngine.cs` est compatible avec `BleEngine.java` (même service, mêmes morceaux de trame, mêmes HELLO/PING).

## Construire et lancer

```bash
cd packages/chat-web && npx vite build
cd ../windows && dotnet build -c Release
./bin/Release/net8.0-windows10.0.19041.0/ChaX.exe
```

Prérequis : Windows 10 (build 19041) ou plus, .NET 8 SDK, runtime WebView2 (présent avec Edge), un adaptateur Bluetooth 4.0+ qui accepte le **rôle périphérique**. `ChaX.exe --probe` écrit dans `%TEMP%\chax-probe.txt` ce que l'adaptateur sait faire.

Les données (identité, historique) sont dans `%LOCALAPPDATA%\ChaX\webview`.

## Limites actuelles

- **Le PC est périphérique uniquement** : il s'annonce et les téléphones viennent à lui. Windows ne peut pas mettre l'identifiant de nœud dans une annonce connectable, donc les téléphones se connectent toujours à lui. Deux PC ne se verront pas en Bluetooth (ils restent joignables par internet).
- Pas de service d'arrière-plan : le mesh ne tourne que fenêtre ouverte. Pas de notifications Windows non plus.
- Pas de vérification de mise à jour (elle est réservée à l'APK).

## Tests et diagnostic

- `ChaX.exe --debug` ouvre le port DevTools 9222 ; `node tools/cdp.mjs "<expression JS>"` exécute du JavaScript dans la page.
- `node tools/pc-phone.mjs <série adb> <pseudo du téléphone vu par le PC> <pseudo du PC vu par le téléphone>` vérifie public et privé dans les deux sens avec un téléphone branché en USB.
- Journal de la couche Bluetooth : `%TEMP%\chax-ble.log`.

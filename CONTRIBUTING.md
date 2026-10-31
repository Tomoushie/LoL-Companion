# Contribuer à LoL BOT

Merci de votre intérêt pour **LoL BOT** ! Ce document explique comment récupérer le projet, le lancer,
tester vos changements et proposer une pull request dans de bonnes conditions.

Le projet est un compagnon desktop **Windows** construit avec **Tauri 2 + Rust** et un frontend
**TypeScript/CSS** sans framework lourd. Les données viennent de Data Dragon, de la Riot API (clé
utilisateur) et d'OP.GG via son MCP public.

---

## 1. Prérequis

- **Windows 10/11 (x64)** — cible actuelle du projet.
- **Node.js 20+** et **pnpm** (`corepack enable` puis `corepack prepare pnpm@latest --activate`).
- **Rust stable** (édition 2021) + `cargo`.
- **Microsoft C++ Build Tools** (Visual Studio Build Tools, charge de travail « Développement Desktop
  en C++ ») et **WebView2 Runtime**.
- Pour le profil Riot : une **clé de développement Riot API** personnelle
  (<https://developer.riotgames.com/>), à ne jamais committer.
- Facultatif pour les scripts : **PowerShell 7** (`pwsh`).

Vérification rapide :

```powershell
node --version
pnpm --version
rustc --version
cargo --version
```

## 2. Cloner et installer

```powershell
git clone https://github.com/Tomoushie/LoL-Companion.git
cd LoL-Companion
pnpm install
```

## 3. Lancer l'application

```powershell
pnpm tauri dev
```

Le frontend Vite démarre et la fenêtre Tauri s'ouvre. Au premier lancement, les données Data Dragon
sont téléchargées dans `%APPDATA%\LoL BOT\cache\ddragon`.

Pour tester le profil Riot, ouvrez l'onglet **Profil**, collez votre clé API Riot puis saisissez un
Riot ID et un serveur. La clé reste dans `%APPDATA%\LoL BOT\config\riot_api_key` et n'est jamais
committée.

## 4. Tests et vérifications

Avant toute pull request, exécutez au minimum :

```powershell
# Tests unitaires Rust (sans réseau)
cd src-tauri
cargo test
cargo check

# Build frontend (TypeScript strict + Vite)
cd ..
pnpm build
```

Scripts d'intégration disponibles :

```powershell
# E2E non-régression de l'interface (nécessite l'app avec CDP)
pwsh -File scripts/e2e-v10.ps1 -SkipBuild

# E2E V0.9/V1.0 selon les scripts présents
pwsh -File scripts/e2e-v10.ps1   # Esport + curseur + non-régression
```

Les tests réseau réels (OP.GG, Riot Esports) sont optionnels et ne doivent pas être ajoutés comme tests
permanents. Utilisez les fixtures et le serveur mock local pour les tests d'intégration :

```powershell
node scripts/mock-riot-server.mjs --port 18765
```

## 5. Structure du projet

```text
src/                     # frontend TypeScript (vues, composants, styles)
src-tauri/src/            # backend Rust (Data Dragon, Riot API, OP.GG MCP, Esport)
scripts/                  # e2e CDP, mock Riot, vérification du cache
docs/                     # captures d'écran et rapport de cache
assets/                   # logo et assets du dépôt
```

## 6. Conventions de code

- **TypeScript strict** : pas de `any`, pas d'`innerHTML`, pas d'`eval`.
- Toutes les commandes Tauri passent par `src/api.ts` : aucun `invoke` direct dans une vue.
- Interface, commentaires et messages d'erreur en **français** ; noms techniques en anglais si utile.
- **Aucune donnée inventée** : une valeur absente s'affiche `—` ; les erreurs réelles sont affichées.
- Thème sombre « cyber » : **pas de couleurs or/brun**.
- Respecter les caches locaux et les rate-limits (Riot API / OP.GG MCP).
- Ne jamais committer de clé API, token, fichier `.env` ou donnée personnelle.
- Pour Rust : `cargo fmt` et `cargo clippy` si possible ; les tests unitaires ne doivent pas dépendre du
  réseau.

## 7. Proposer une pull request

1. **Forkez** le dépôt puis créez une branche descriptive :
   ```powershell
   git checkout -b feat/rune-combinations
   ```
2. Faites des commits petits et explicites (style `feat:`, `fix:`, `docs:`, `test:`).
3. Vérifiez que `cargo test` et `pnpm build` passent.
4. Poussez votre branche et ouvrez une **pull request** vers `main`, en décrivant :
   - le problème résolu ou la fonctionnalité ;
   - les données sources utilisées (et leur cache) ;
   - les tests/captures réalisés ;
   - les limites ou données manquantes.
5. Un mainteneur relira la PR. Les retours peuvent demander des changements ; restez courtois et
   factuel (voir `CODE_OF_CONDUCT.md`).

### Checklist PR

- [ ] `cargo test` passe.
- [ ] `cargo check` passe.
- [ ] `pnpm build` passe (TS strict).
- [ ] Aucun secret, cache local ou binaire dans le diff.
- [ ] Les nouvelles valeurs absentes affichent `—`.
- [ ] Les caches/rate-limits sont respectés.
- [ ] Documentation/captures mises à jour si l'interface change.

## 8. Signaler un bug ou une idée

- Ouvrez une [issue GitHub](https://github.com/Tomoushie/LoL-Companion/issues) avec :
  - version de Windows et version de l'app ;
  - étapes pour reproduire ;
  - comportement attendu vs observé ;
  - capture ou message d'erreur (sans clé API).
- Pour une faille de sécurité, contactez **nowaktombe@protonmail.com** en privé au lieu d'ouvrir une
  issue publique.

## 9. Licence

En contribuant, vous acceptez que votre contribution soit distribuée sous la **licence MIT** du projet.
Vous conservez la mention de copyright et le texte de la licence.

Merci pour vos contributions !

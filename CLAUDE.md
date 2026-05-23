# CLAUDE.md — Regole permanenti (versione Windows)

Queste regole valgono per ogni modifica al codice di TradingView2Claude
Connector versione Windows. Non derogarle senza esplicito consenso utente.

## Parità con Mac dev 2.0

- **Il codice JS lato app è UNO solo, cross-platform** (`main.js`,
  `claude-engine.js`, `memory.js`, `dashboard.html`, `index.html`, persona).
  Si scrive una volta e si copia tra `tradingview2claude-connector-mac-dev`
  e `tradingview2claude-connector-win`. Le differenze di piattaforma sono
  gestite con `if (IS_WIN) / if (IS_MAC)` inline, non con file separati.
- **Quando aggiungi una feature**, falla cross-platform e copia il file
  modificato in entrambe le repo. Una sorgente di verità sola.

## Vincoli di prodotto (uguali alla Mac)

- **Cliente usa SUO abbonamento Claude.** Mai API key Anthropic.
- **Persona non rivela mai di essere Claude.**
- **Briefing partono solo con app aperta** (v1).
- **Licenza sospesa NON cancella la chiave.** Solo avviso, riavvio riprende.
- **Report diagnostico NON include la chiave licenza.**
- **bundled-mcp NON deve contenere `.git`** (path lunghi + read-only su pack).

## Specifiche Windows

- **Installer**: NSIS, oneClick:false (l'utente sceglie cartella),
  perMachine:false (no admin), createDesktopShortcut:true.
- **Niente requireAdministrator** — l'app scrive solo in `%USERPROFILE%`
  e `%LOCALAPPDATA%`, niente serve admin.
- **Distribuzione**: PowerShell one-liner `irm install.ps1 | iex` da
  `bit.ly/tv2cdashboard-win`. Niente download manuale dal browser.
- **Claude install**: `irm https://claude.ai/install.ps1 | iex` (installer
  nativo Anthropic, NON via npm). Binario in `%USERPROFILE%\.local\bin`.
- **Node bundled**: `bundled-node\node-win-x64\node.exe` scaricato dal
  workflow CI (no dipendenza dal Node del cliente).
- **MCP registrato** direttamente come `node.exe server.js`, niente wrapper
  `.bat` (su Mac serve `.sh` per env personalizzato; su Win no).
- **spawn(claude.cmd, …)** richiede `shell: true` e `windowsHide: true`.
  Kill via `taskkill /F /T /PID` (non SIGTERM).

## Build CI

- Workflow `windows-latest`, deve produrre EXE NSIS x64.
- Step "Setup bundled-mcp" deve clonare, applicare patch PowerShell
  `(t.type === 'page' || t.type === 'webview')`, `npm install`, e
  rimuovere `.git`.
- Step "Setup bundled-node" scarica node-v22.11.0-win-x64.zip e lo
  estrae in `bundled-node/node-win-x64/`.
- Step "Genera icon.ico" converte `assets/icon.png` in `assets/icon.ico`
  con System.Drawing (256x256). Salta se già presente.

## Git / Release

- Repo: `itsmanuelbaby/tradingview2claude-connector-win` (pubblica).
- Branch lavoro: `v2-port` finché il porting non è verificato, poi merge in `main`.
- Release: `gh release create vX.Y.Z dist/*.exe`. L'asset DEVE chiamarsi
  `TradingView2Claude-Setup-${version}.exe` (atteso da `install.ps1`).

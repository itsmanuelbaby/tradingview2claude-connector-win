TradingView2Claude Connector — versione Windows 2.0
=====================================================

Cos'è
-----
Applicazione per Windows che riunisce in un'unica finestra un assistente AI
di analisi tecnica (Claude) e il grafico TradingView. L'assistente legge i
dati reali del grafico, risponde in linguaggio naturale, imposta alert,
scrive indicatori Pine, cerca notizie dal web, conserva memoria di tutte
le analisi.

Il cliente usa il SUO abbonamento Claude (Pro o Max). Nessuna API key.

Installazione (per il cliente finale)
-------------------------------------
Apre PowerShell (o Windows Terminal) e incolla:

    irm https://bit.ly/tv2cdashboard-win | iex

Lo script scarica l'installer dalla Release più recente e lo lancia.

Cosa serve sul PC del cliente:
- Windows 10/11 x64
- Connessione internet
- Account Claude attivo (Pro o Max)
- Account TradingView (anche free)

Tutto il resto (binario Claude, Node.js, MCP TradingView) è incluso
nel pacchetto o si installa in automatico al primo avvio.

Architettura (parità con Mac dev 2.0)
-------------------------------------
- src/main.js          → orchestrazione Electron, IPC, scheduler briefing
- src/claude-engine.js → spawn `claude` headless con streaming NDJSON
- src/memory.js        → vault Obsidian (Documenti\TradingView2Claude Vault\)
- src/dashboard.html   → UI unica (chat + webview TradingView + divisore)
- src/index.html       → schermata setup/licenza
- src/persona.txt      → istruzioni assistente (IT)
- src/persona-en.txt   → istruzioni assistente (EN)
- bundled-mcp/         → MCP TradingView patched per accettare webview
- bundled-node/        → Node.js portable Windows x64 (per eseguire MCP)
- assets/icon.ico      → icona generata dal workflow CI da icon.png
- license-api/         → Google Apps Script per validazione licenze

Build
-----
Push su `main` o `v2-port` → GitHub Actions builda automaticamente
l'EXE NSIS su `windows-latest` e lo carica come artifact.

Release
-------
Per pubblicare:
  gh release create v2.0.0 dist/*.exe --title "v2.0.0" --notes "Release 2.0"

L'EXE si chiama TradingView2Claude-Setup-2.0.0.exe (il nome che install.ps1
si aspetta come asset latest).

Differenze chiave vs versione Mac
---------------------------------
- Path log:     %LOCALAPPDATA%\TradingView2Claude\Logs    (Mac: ~/Library/Logs)
- Vault:        %USERPROFILE%\Documents\TradingView2Claude Vault  (id. cross-platform)
- Binario:      claude.exe / claude.cmd                    (Mac: claude)
- Installer:    iwr install.ps1 | iex                      (Mac: curl install.sh | bash)
- Machine ID:   wmic csproduct + registry MachineGuid     (Mac: IOPlatformUUID)
- Distribuzione: NSIS EXE                                  (Mac: DMG x64+arm64)

main.js è UNICO cross-platform: si scrive una volta sola e si copia tra
i due repo mac-dev e win-dev. Gli if(IS_WIN)/if(IS_MAC) coprono le
differenze locali.

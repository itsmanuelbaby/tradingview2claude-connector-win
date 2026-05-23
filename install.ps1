# ================================================================
#  TradingView2Claude Connector — installer PowerShell (Windows)
#
#  Uso (PowerShell o Windows Terminal):
#    irm https://bit.ly/tv2cdashboard-win | iex
#
#  Scarica l'EXE NSIS dalla Release più recente e lo lancia.
#  Niente quarantena, niente warning "file scaricato dal web" da
#  aprire a mano: l'utente esegue l'installer normalmente.
# ================================================================

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'   # Invoke-WebRequest molto più veloce

$REPO        = 'itsmanuelbaby/tradingview2claude-connector-win'
$ASSET_NAME  = 'TradingView2Claude-Setup-2.0.1.exe'
$DOWNLOAD    = "https://github.com/$REPO/releases/latest/download/$ASSET_NAME"
$DEST_DIR    = Join-Path $env:TEMP 'TradingView2Claude-Install'
$DEST_FILE   = Join-Path $DEST_DIR $ASSET_NAME

function Write-Step($msg) {
  Write-Host ""
  Write-Host "  $msg" -ForegroundColor Yellow
}

function Write-Ok($msg)   { Write-Host "  $msg" -ForegroundColor Green }
function Write-Err($msg)  { Write-Host "  $msg" -ForegroundColor Red }

Write-Host ""
Write-Host "  +================================================+" -ForegroundColor DarkYellow
Write-Host "  |     TradingView2Claude Connector — Installer    |" -ForegroundColor DarkYellow
Write-Host "  +================================================+" -ForegroundColor DarkYellow

# ── 1. Prepara la cartella temporanea ────────────────────────────
Write-Step "Preparazione..."
if (-not (Test-Path $DEST_DIR)) { New-Item -ItemType Directory -Path $DEST_DIR | Out-Null }
if (Test-Path $DEST_FILE)       { Remove-Item -Force $DEST_FILE }

# ── 2. Download dell'installer dalla Release latest ──────────────
Write-Step "Scarico l'installer dalla Release più recente..."
try {
  Invoke-WebRequest -Uri $DOWNLOAD -OutFile $DEST_FILE -UseBasicParsing
} catch {
  Write-Err "Download fallito: $($_.Exception.Message)"
  Write-Err "Verifica la connessione e la presenza della Release sul repo."
  exit 1
}
$sizeMB = [math]::Round((Get-Item $DEST_FILE).Length / 1MB, 1)
Write-Ok "Installer scaricato ($sizeMB MB)"

# ── 3. Lancia l'installer NSIS ───────────────────────────────────
Write-Step "Avvio dell'installer..."
Write-Host "  Segui le istruzioni a schermo per scegliere la cartella di installazione."
Write-Host ""

# Lancia l'EXE senza attendere — NSIS apre la sua UI; il terminale resta libero.
Start-Process -FilePath $DEST_FILE

Write-Ok "Installer avviato. Buon trading."
Write-Host ""

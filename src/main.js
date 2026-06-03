'use strict';

// ================================================================
//  TradingView2Claude Connector — main.js (cross-platform Mac/Win)
//  Self-contained: bundled-mcp e bundled-node inclusi nel pacchetto
// ================================================================

const { app, BrowserWindow, ipcMain, shell, net } = require('electron');
const path   = require('path');
const { spawn, exec, execSync } = require('child_process');
const fs     = require('fs');
const os     = require('os');
const crypto = require('crypto');
const claudeEngine = require('./claude-engine');

// Porta debug: espone il TradingView incorporato all'MCP (server.js)
app.commandLine.appendSwitch('remote-debugging-port', '9222');

// ── Costanti ─────────────────────────────────────────────────────
const HOME    = os.homedir();
const IS_MAC  = process.platform === 'darwin';
const IS_WIN  = process.platform === 'win32';

const LOG_DIR = IS_WIN
  ? path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'),
              'TradingView2Claude', 'Logs')
  : path.join(HOME, 'Library', 'Logs', 'TradingView2Claude');
const LOG_FILE = path.join(LOG_DIR, 'installer.log');

// ── Logger ───────────────────────────────────────────────────────
function initLog() {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch(_) {}
}

function writeLog(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch(_) {}
}

function sendLog(msg, win) {
  writeLog(msg);
  if (win && !win.isDestroyed()) {
    win.webContents.send('log', msg);
  }
}

// ── Path bundled-mcp ─────────────────────────────────────────────
function getBundledMcpPath() {
  let p = app.isPackaged
    ? path.join(process.resourcesPath, 'bundled-mcp')
    : path.join(__dirname, '..', 'bundled-mcp');
  try { p = fs.realpathSync(p); } catch(_) {}
  return p;
}

// ── Path bundled-node ────────────────────────────────────────────
// Mac: node-x64 / node-arm64 (singolo binario)
// Win: node-win-x64\node.exe
function getBundledNodePath() {
  let base = app.isPackaged
    ? path.join(process.resourcesPath, 'bundled-node')
    : path.join(__dirname, '..', 'bundled-node');
  try { base = fs.realpathSync(base); } catch(_) {}
  if (!fs.existsSync(base)) return null;
  if (IS_WIN) {
    const nodeExe = path.join(base, 'node-win-x64', 'node.exe');
    return fs.existsSync(nodeExe) ? nodeExe : null;
  }
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const nodeBin = path.join(base, `node-${arch}`);
  return fs.existsSync(nodeBin) ? nodeBin : null;
}

// ── Helper: run processo ─────────────────────────────────────────
function run(cmd, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const { cwd, ignoreError, env, shell } = opts;
    const mergedEnv = { ...process.env, ...env };
    // shell:true serve su Windows SOLO per .cmd/.bat. Per .exe (powershell,
    // node, ecc.) usare shell:false evita che cmd intercetti pipe/redirezioni.
    const needsShell = (shell !== undefined)
      ? shell
      : (IS_WIN && /\.(cmd|bat)$/i.test(cmd));
    const child = spawn(cmd, args, {
      cwd: cwd || HOME,
      shell: needsShell,
      env: mergedEnv,
      windowsHide: true,
    });
    let stdout = '', stderr = '';
    child.stdout?.on('data', d => { stdout += d; });
    child.stderr?.on('data', d => { stderr += d; });
    child.on('close', code => {
      writeLog(`[run] ${cmd} ${args.join(' ')} → exit ${code}`);
      if (stderr) writeLog(`[stderr] ${stderr.trim()}`);
      if (code !== 0 && !ignoreError) {
        reject(new Error(`${cmd} uscito con codice ${code}\nstderr: ${stderr}\nstdout: ${stdout}`));
      } else {
        resolve(stdout.trim());
      }
    });
    child.on('error', err => {
      writeLog(`[run error] ${cmd}: ${err.message}`);
      if (!ignoreError) reject(err);
      else resolve('');
    });
  });
}

function runQ(cmd, timeoutMs = 10000) {
  return new Promise(resolve => {
    exec(cmd, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
  });
}

// ── Finestra principale (setup) ──────────────────────────────────
let mainWin = null;

function createWindow() {
  mainWin = new BrowserWindow({
    width: 820, height: 640,
    resizable: false,
    frame: IS_WIN ? false : undefined,
    titleBarStyle: IS_MAC ? 'hiddenInset' : undefined,
    backgroundColor: '#0D0D0D',
    icon: path.join(__dirname, '..', 'assets',
                    IS_WIN ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  mainWin.loadFile(path.join(__dirname, 'index.html'));
  mainWin.on('closed', () => { mainWin = null; });
}

// ── Finestra Dashboard (prodotto principale) ─────────────────────
let dashWin = null;

function createDashboardWindow() {
  dashWin = new BrowserWindow({
    width: 1320, height: 850,
    minWidth: 900, minHeight: 600,
    frame: false,
    backgroundColor: '#0D0D0D',
    icon: path.join(__dirname, '..', 'assets',
                    IS_WIN ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true,
    },
  });
  dashWin.loadFile(path.join(__dirname, 'dashboard.html'));
  dashWin.on('closed', () => { dashWin = null; });
}

// ── Aggiorna PATH leggendo da registry user+machine (Windows) ────
// L'installer Anthropic aggiunge il binario al PATH user via registry,
// ma il process Electron ha la sua cache PATH presa allo startup.
// Senza refresh, `where claude` continuerebbe a non vederlo.
async function refreshWinPath() {
  if (!IS_WIN) return;
  try {
    const sys = await runQ('powershell -NoProfile -ExecutionPolicy Bypass -Command "[Environment]::GetEnvironmentVariable(\'PATH\',\'Machine\')"');
    const usr = await runQ('powershell -NoProfile -ExecutionPolicy Bypass -Command "[Environment]::GetEnvironmentVariable(\'PATH\',\'User\')"');
    const merged = [sys, usr, process.env.PATH].filter(Boolean).join(';');
    if (merged) process.env.PATH = merged;
  } catch (_) {}
}

// ── Trova Claude (cross-platform, esaustivo per Windows) ─────────
async function findClaude() {
  if (IS_WIN) {
    const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
    const LOCAL   = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
    const PF      = process.env.ProgramFiles || 'C:\\Program Files';
    const PFx86   = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    // L'installer ufficiale Anthropic (install.ps1) usa il path .claude/.
    // L'install via npm globale usa %APPDATA%\npm. L'install via App Installer
    // o MSI può finire in Program Files. Coprire tutte le combinazioni note.
    const candidates = [
      // Installer nativo Anthropic (vari layout possibili: .local/.bin/ direct)
      path.join(HOME, '.claude', 'local', 'claude.exe'),
      path.join(HOME, '.claude', 'bin', 'claude.exe'),
      path.join(HOME, '.claude', 'claude.exe'),
      path.join(HOME, '.local', 'bin', 'claude.exe'),
      path.join(HOME, '.local', 'bin', 'claude.cmd'),
      path.join(HOME, '.local', 'bin', 'claude'),
      // npm globale
      path.join(APPDATA, 'npm', 'claude.cmd'),
      path.join(LOCAL,   'npm', 'claude.cmd'),
      // MSI / Program Files
      path.join(LOCAL, 'Programs', 'Claude', 'claude.exe'),
      path.join(LOCAL, 'Programs', 'claude', 'claude.exe'),
      path.join(LOCAL, 'Anthropic', 'Claude', 'claude.exe'),
      path.join(PF, 'Anthropic', 'Claude', 'claude.exe'),
      path.join(PFx86, 'Anthropic', 'Claude', 'claude.exe'),
      path.join(PF, 'nodejs', 'claude.cmd'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    // Fallback 1: where (legge da PATH process)
    const w = await runQ('where claude');
    if (w) {
      const first = w.split(/\r?\n/)[0].trim();
      if (first && fs.existsSync(first)) return first;
    }
    // Fallback 2: Get-Command in PowerShell (più affidabile per .ps1/.cmd)
    const gc = await runQ('powershell -NoProfile -ExecutionPolicy Bypass -Command "(Get-Command claude -ErrorAction SilentlyContinue).Source"');
    if (gc && fs.existsSync(gc.trim())) return gc.trim();
    return null;
  }
  // ── macOS ──
  const localBin = path.join(HOME, '.local', 'bin', 'claude');
  if (fs.existsSync(localBin)) return localBin;
  const npmPaths = [
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    path.join(HOME, '.npm-global', 'bin', 'claude'),
    path.join(HOME, 'Library', 'Application Support', 'npm', 'bin', 'claude'),
  ];
  for (const p of npmPaths) {
    if (fs.existsSync(p)) return p;
  }
  const w = await runQ('which claude');
  if (w && fs.existsSync(w)) return w;
  return null;
}

// ── Licenze: machine id (cross-platform) ─────────────────────────
function getMachineId() {
  if (IS_WIN) {
    // 1) UUID hardware via wmic
    try {
      const out = execSync('wmic csproduct get uuid', { encoding: 'utf8', timeout: 5000 });
      const lines = out.split(/\r?\n/).map(l => l.trim()).filter(l => l && l !== 'UUID');
      if (lines.length && /^[0-9A-F-]{20,}$/i.test(lines[0])) {
        return crypto.createHash('sha256').update(lines[0]).digest('hex').substring(0, 32);
      }
    } catch (_) {}
    // 2) Registro MachineGuid
    try {
      const out = execSync('reg query HKLM\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid',
                           { encoding: 'utf8', timeout: 5000 });
      const m = out.match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/i);
      if (m && m[1].trim()) {
        return crypto.createHash('sha256').update(m[1].trim()).digest('hex').substring(0, 32);
      }
    } catch (_) {}
  } else {
    // macOS: IOPlatformUUID
    try {
      const out = execSync(
        'ioreg -rd1 -c IOPlatformExpertDevice | grep IOPlatformUUID',
        { encoding: 'utf8', timeout: 5000 }
      );
      const m = out.match(/"([A-F0-9-]{36})"/i);
      if (m) return crypto.createHash('sha256').update(m[1]).digest('hex').substring(0, 32);
    } catch(_) {}
  }
  // Fallback comune: hostname + username
  return crypto.createHash('sha256')
    .update(os.hostname() + os.userInfo().username)
    .digest('hex').substring(0, 32);
}

const GAS_URL = 'https://script.google.com/macros/s/AKfycbyXx0246ZvZtieTHHLUgsG4bbZirOVMGnDgT788bodMVkwjY_6Pnusho2IAL3YSrZSW/exec';
const API_TIMEOUT_MS = 15000;

async function apiPost(payload) {
  const data = JSON.stringify(payload);
  // 1) fetch globale (Node 18+ undici)
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    try {
      const res = await fetch(GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: data,
        signal: controller.signal,
      });
      const text = await res.text();
      try { return JSON.parse(text); } catch { return { ok: false, error: text }; }
    } finally { clearTimeout(timer); }
  } catch (e) {
    // 2) Fallback su net.fetch di Electron
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
      try {
        const res2 = await net.fetch(GAS_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: data,
          signal: controller.signal,
        });
        const text = await res2.text();
        try { return JSON.parse(text); } catch { return { ok: false, error: text }; }
      } finally { clearTimeout(timer); }
    } catch (e2) {
      if (e.name === 'AbortError' || e2.name === 'AbortError') {
        throw new Error('Timeout connessione (15s) — riprova');
      }
      throw new Error(`fetch: ${e.message} | net.fetch: ${e2.message}`);
    }
  }
}

const LICENSE_FILE = path.join(HOME, '.tv2claude_license');
function saveLicense(data)  { try { fs.writeFileSync(LICENSE_FILE, JSON.stringify(data)); } catch(_) {} }
function loadLicense()      { try { return JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf8')); } catch { return null; } }

// ── IPC: Log ─────────────────────────────────────────────────────
ipcMain.handle('get-log', () => {
  try { return fs.readFileSync(LOG_FILE, 'utf8'); } catch { return ''; }
});

ipcMain.handle('open-log', () => {
  shell.openPath(LOG_FILE);
});

// ── Step 0: Info sistema ─────────────────────────────────────────
async function step0_sistema() {
  initLog();
  writeLog('=== NUOVA INSTALLAZIONE ===');
  writeLog(`App versione: ${app.getVersion()}`);
  writeLog(`app.isPackaged: ${app.isPackaged}`);
  writeLog(`process.resourcesPath: ${process.resourcesPath}`);
  writeLog(`Sistema: ${process.platform} ${os.release()}`);
  writeLog(`Architettura: ${process.arch}`);
  writeLog(`HOME: ${HOME}`);
  writeLog(`bundled-mcp path: ${getBundledMcpPath()}`);
  writeLog(`bundled-node path: ${getBundledNodePath() || 'non trovato'}`);

  const osName = IS_WIN ? 'Windows' : IS_MAC ? 'macOS' : process.platform;
  sendLog(`Sistema: ${osName} ${process.arch} (${os.release()})`, mainWin);
  const nodeBin = getBundledNodePath();
  if (nodeBin) {
    const cmd = IS_WIN ? `"${nodeBin}" --version` : `"${nodeBin}" --version`;
    const v = await runQ(cmd);
    sendLog(`Node.js bundled: ${v || 'errore lettura versione'}`, mainWin);
  } else {
    const v = await runQ('node --version');
    sendLog(`Node.js runtime: ${v || 'non trovato'}`, mainWin);
  }
}

// ── Step: Claude Code (installer nativo Anthropic) ───────────────
async function step3_claude() {
  let claudePath = await findClaude();
  if (claudePath) {
    sendLog(`Claude Code già installato: ${claudePath}`, mainWin);
    return claudePath;
  }

  sendLog('Installazione di Claude Code in corso...', mainWin);

  if (IS_WIN) {
    // Windows: installer ufficiale Anthropic via PowerShell.
    // IMPORTANTE: shell:false → spawn diretto. Se usassimo shell:true cmd.exe
    // intercetterebbe il pipe `|` e proverebbe a piparlo a `iex` (comando cmd
    // inesistente) prima ancora che PowerShell lo veda.
    try {
      await run('powershell.exe', [
        '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        "irm https://claude.ai/install.ps1 | iex"
      ], { cwd: HOME, ignoreError: false, shell: false });
    } catch (e) {
      writeLog(`[step3] installer nativo PowerShell: ${e.message}`);
    }
  } else {
    // macOS: installer ufficiale Anthropic via bash
    const safeEnv = {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin:'
          + (process.env.PATH || ''),
    };
    try {
      await run('/bin/bash',
        ['-c', 'curl -fsSL https://claude.ai/install.sh | bash'],
        { cwd: HOME, env: safeEnv, ignoreError: false });
    } catch (e) {
      writeLog(`[step3] installer nativo bash: ${e.message}`);
    }
  }

  // Attendi un attimo per la scrittura su disco + registry, poi
  // aggiorna PATH per raccogliere modifiche fatte dall'installer.
  await new Promise(r => setTimeout(r, 2500));
  await refreshWinPath();
  claudePath = await findClaude();

  // Retry più lungo + secondo refresh PATH (su PC lenti l'installer
  // può impiegare di più a registrare il binario).
  if (!claudePath) {
    sendLog('Verifica installazione in corso...', mainWin);
    await new Promise(r => setTimeout(r, 4000));
    await refreshWinPath();
    claudePath = await findClaude();
  }

  if (claudePath) {
    // Verifica funzionante: --version deve rispondere. Se il binario c'è
    // ma è broken (dipendenza mancante, AV in quarantena, ecc.), meglio
    // saperlo subito invece di fallire nella prima chat.
    const vCmd = IS_WIN ? `"${claudePath}" --version` : `"${claudePath}" --version`;
    const v = await runQ(vCmd, 8000);
    if (v) {
      sendLog(`Claude Code installato: ${claudePath} (${v.split('\n')[0]})`, mainWin);
    } else {
      sendLog(`Claude Code installato ma non risponde a --version: ${claudePath}`, mainWin);
      writeLog('[step3] WARNING: claude --version non risponde — potrebbe avere problemi');
    }
    return claudePath;
  }

  const manualCmd = IS_WIN
    ? '  irm https://claude.ai/install.ps1 | iex   (in PowerShell)'
    : '  curl -fsSL https://claude.ai/install.sh | bash   (nel Terminale)';
  throw new Error(
    'Non è stato possibile installare Claude Code automaticamente.\n\n' +
    'Apri ' + (IS_WIN ? 'PowerShell' : 'il Terminale') +
    ', incolla questo comando e premi Invio:\n' +
    manualCmd + '\n\n' +
    'Al termine, torna qui e premi "Riprova".'
  );
}

// ── Step: configura l'assistente (registra l'MCP bundled) ────────
async function step_assistant(claudePath) {
  const bundledMcp = getBundledMcpPath();
  const serverJs = path.join(bundledMcp, 'src', 'server.js');

  if (!fs.existsSync(serverJs)) {
    sendLog('Assistente: uso la configurazione esistente', mainWin);
    writeLog(`[assistant] MCP bundled assente (${serverJs}) — skip`);
    return;
  }
  if (!claudePath) throw new Error('Claude Code non disponibile');

  const nodeBin = getBundledNodePath() || 'node';

  // Rimuovi vecchie registrazioni (idempotente)
  for (const old of ['tradingview', 'tradingview-mcp']) {
    await run(claudePath, ['mcp', 'remove', '--scope', 'user', old],
      { cwd: HOME, ignoreError: true });
  }

  if (IS_WIN) {
    // Windows: registra direttamente node.exe server.js (niente wrapper)
    await run(claudePath,
      ['mcp', 'add', '--scope', 'user', 'tradingview-mcp', '--', nodeBin, serverJs],
      { cwd: HOME, ignoreError: false });
  } else {
    // macOS: wrapper .sh perché spawn con env personalizzato è più robusto
    const wrapperPath = path.join(HOME, '.tv2claude_mcp.sh');
    fs.writeFileSync(wrapperPath,
      `#!/bin/bash\nexec "${nodeBin}" "${serverJs}"\n`,
      { encoding: 'utf8', mode: 0o755 });
    writeLog(`[assistant] wrapper MCP: ${wrapperPath}`);
    await run(claudePath,
      ['mcp', 'add', '--scope', 'user', 'tradingview-mcp', '/bin/bash', wrapperPath],
      { cwd: HOME, ignoreError: false });
  }

  sendLog('Assistente di mercato configurato ✓', mainWin);
}

// ── Pipeline di setup (4 step: Sistema, Claude, Assistente, Login) ──
async function runInstall() {
  function stepEvent(i, s) { mainWin?.webContents.send('step', { index: i, status: s }); }
  function progress(p)     { mainWin?.webContents.send('progress', p); }

  try {
    stepEvent(0, 'running');
    await step0_sistema();
    stepEvent(0, 'done'); progress(25);

    stepEvent(1, 'running');
    const claudePath = await step3_claude();
    stepEvent(1, 'done'); progress(50);

    stepEvent(2, 'running');
    await step_assistant(claudePath);
    stepEvent(2, 'done'); progress(75);

    // Step 4: login Claude. Se fallisce con LOGIN_REQUIRED, la UI mostra
    // overlay; alla pressione di "Continua" il client manda 'retry-login'
    // che rifa SOLO questo step.
    stepEvent(3, 'running');
    try {
      await step4_login();
      markSetupAcknowledged();
      stepEvent(3, 'done'); progress(100);
      mainWin?.webContents.send('done', { ok: true });
    } catch (e) {
      if (e.alreadyLoggedIn) {
        stepEvent(3, 'waiting');
        mainWin?.webContents.send('await-confirm', { msg: e.message, email: e.email });
      } else if (/login richiesto/i.test(e.message)) {
        stepEvent(3, 'waiting');
        mainWin?.webContents.send('await-login', { msg: e.message });
      } else { throw e; }
    }
  } catch (e) {
    writeLog(`[ERRORE setup] ${e.stack || e.message}`);
    mainWin?.webContents.send('done', { ok: false, msg: e.message });
  }
}

// L'utente preme "Continua" dopo il login → ricontrolla solo step 4
ipcMain.on('retry-login', async () => {
  function stepEvent(i, s) { mainWin?.webContents.send('step', { index: i, status: s }); }
  function progress(p)     { mainWin?.webContents.send('progress', p); }
  stepEvent(3, 'running');
  try {
    await step4_login();
    markSetupAcknowledged();
    stepEvent(3, 'done'); progress(100);
    mainWin?.webContents.send('done', { ok: true });
  } catch (e) {
    if (e.alreadyLoggedIn) {
      stepEvent(3, 'waiting');
      mainWin?.webContents.send('await-confirm', { msg: e.message, email: e.email });
    } else if (/login richiesto/i.test(e.message)) {
      stepEvent(3, 'waiting');
      mainWin?.webContents.send('await-login', { msg: e.message });
    } else {
      writeLog(`[ERRORE retry-login] ${e.stack || e.message}`);
      mainWin?.webContents.send('done', { ok: false, msg: e.message });
    }
  }
});

// Conferma login esistente: l'utente era già loggato e preme "Continua"
ipcMain.on('confirm-existing-login', () => {
  function stepEvent(i, s) { mainWin?.webContents.send('step', { index: i, status: s }); }
  function progress(p)     { mainWin?.webContents.send('progress', p); }
  if (isClaudeLoggedIn()) {
    markSetupAcknowledged();
    stepEvent(3, 'done'); progress(100);
    mainWin?.webContents.send('done', { ok: true });
  } else {
    stepEvent(3, 'waiting');
    mainWin?.webContents.send('await-login', {
      msg: 'Non risulti più loggato. Apri il Terminale e fai login a Claude.'
    });
  }
});

// IPC dashboard: chi è loggato? (per popup benvenuto)
ipcMain.handle('claude:get-account', () => getClaudeAccount());

// IPC dashboard: apre Terminale/PowerShell con `claude` per fare login
ipcMain.on('open-claude-login-terminal', async () => {
  // Path assoluto (vedi commento in step4_login)
  const claudeBin = await findClaude();
  const claudeCmd = claudeBin || 'claude';
  if (IS_MAC) {
    try {
      await run('osascript', [
        '-e', 'tell application "Terminal" to activate',
        '-e', `tell application "Terminal" to do script "${claudeCmd}"`,
      ], { ignoreError: true });
    } catch (_) {}
  } else if (IS_WIN) {
    try {
      await run('cmd.exe', ['/c', 'start', '', 'powershell.exe', '-NoExit', '-Command', claudeCmd],
        { ignoreError: true, shell: false });
    } catch (_) {}
  }
});

// ── Verifica se il setup è già completo ──────────────────────────
async function isSetupComplete() {
  const claude = await findClaude();
  if (!claude) return false;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8'));
    const hasMcp = !!(cfg && cfg.mcpServers && cfg.mcpServers['tradingview-mcp']);
    const isLogged = !!(cfg && cfg.oauthAccount && cfg.oauthAccount.emailAddress);
    // Flag setup_done richiesto: primo avvio dopo install deve passare per
    // la schermata di benvenuto/conferma anche se già loggato.
    return hasMcp && isLogged && isSetupAcknowledged();
  } catch {
    return false;
  }
}

// ── Verifica se l'utente ha fatto login a Claude ─────────────────
// Claude CLI salva lo stato OAuth in ~/.claude.json sotto oauthAccount.
// Se l'utente non ha mai fatto `claude` interattivo, il campo è assente.
function isClaudeLoggedIn() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8'));
    return !!(cfg && cfg.oauthAccount && cfg.oauthAccount.emailAddress);
  } catch {
    return false;
  }
}

function getClaudeUserEmail() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8'));
    return cfg?.oauthAccount?.emailAddress || null;
  } catch { return null; }
}

// Restituisce informazioni complete sull'account Claude per il popup di benvenuto
function getClaudeAccount() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8'));
    const o = cfg?.oauthAccount;
    if (o && o.emailAddress) {
      return {
        loggedIn: true,
        email: o.emailAddress,
        displayName: o.displayName || o.emailAddress.split('@')[0],
        organization: o.organizationName || null,
      };
    }
  } catch (_) {}
  return { loggedIn: false };
}

// ── Flag "setup obbligatorio completato" ────────────────────────
const SETUP_DONE_FLAG = path.join(HOME, '.tv2claude_setup_done');
function isSetupAcknowledged() { return fs.existsSync(SETUP_DONE_FLAG); }
function markSetupAcknowledged() {
  try { fs.writeFileSync(SETUP_DONE_FLAG, new Date().toISOString()); }
  catch (e) { writeLog('setup-flag write error: ' + e.message); }
}

// ── Step 4: Login Claude (apre Terminale per OAuth interattivo) ──
// Claude headless (-p) non può fare OAuth: serve una sessione TTY.
// Apriamo Terminal.app (Mac) o PowerShell (Win) con `claude` per scatenare
// il flusso login; l'utente completa nel browser, noi attendiamo che lo
// state cambi (campo oauthAccount in ~/.claude.json).
async function step4_login() {
  if (isClaudeLoggedIn()) {
    if (isSetupAcknowledged()) {
      const email = getClaudeUserEmail();
      sendLog(`Accesso Claude già attivo${email ? ' (' + email + ')' : ''}`, mainWin);
      return;
    }
    // Primo avvio dopo install: anche se loggato, l'utente deve confermare
    const email = getClaudeUserEmail();
    sendLog(`Già loggato a Claude come ${email}. Conferma richiesta.`, mainWin);
    const e = new Error('Conferma richiesta: sei già loggato a Claude. Premi "Continua" per confermare e procedere.');
    e.alreadyLoggedIn = true;
    e.email = email;
    throw e;
  }
  sendLog('Apro una finestra di terminale per il login Claude (browser OAuth)...', mainWin);

  // PATH ASSOLUTO al binario: l'installer Anthropic mette claude in
  // ~/.local/bin/ o ~/.claude/local/ che NON è nel PATH di default della
  // shell utente. Se passassimo solo "claude" il terminale risponderebbe
  // "command not found" / "non riconosciuto come comando interno o esterno".
  const claudeBin = await findClaude();
  const claudeCmd = claudeBin || 'claude';

  if (IS_MAC) {
    try {
      await run('osascript', [
        '-e', 'tell application "Terminal" to activate',
        '-e', `tell application "Terminal" to do script "${claudeCmd}"`,
      ], { ignoreError: true });
    } catch (_) {}
  } else if (IS_WIN) {
    try {
      await run('cmd.exe',
        ['/c', 'start', '', 'powershell.exe', '-NoExit', '-Command', claudeCmd],
        { ignoreError: true, shell: false });
    } catch (_) {}
  }

  // Notifica la UI: serve azione utente. La UI mostra overlay e bottone
  // "Continua" che fa partire 'retry-login' per rifare solo questo step.
  throw new Error('Login richiesto: completa l\'accesso a Claude nel browser appena aperto, poi premi "Continua".');
}

// ── Verifica licenza all'avvio (con tolleranza offline) ──────────
async function verifyLicenseStatus(key) {
  try {
    const res = await apiPost({ action: 'validate', license_key: key });
    if (res && res.ok) return 'valid';
    return 'suspended';
  } catch (e) {
    writeLog(`[license] verifica offline: ${e.message}`);
    return 'offline';
  }
}

// ── IPC handlers ─────────────────────────────────────────────────
ipcMain.on('start-install', () => { runInstall(); });
ipcMain.on('open-url', (_, url) => { shell.openExternal(url); });

ipcMain.on('open-dashboard', () => {
  createDashboardWindow();
  if (mainWin && !mainWin.isDestroyed()) mainWin.close();
});

// ── Report diagnostico ───────────────────────────────────────────
async function generateDiagnosticReport() {
  const L = [];
  L.push('═══ TradingView2Claude Connector — Report Diagnostico ═══');
  L.push('Generato: ' + new Date().toISOString().replace('T', ' ').slice(0, 19));
  L.push('App versione: ' + app.getVersion());
  const osName = IS_WIN ? 'Windows' : IS_MAC ? 'macOS' : process.platform;
  L.push(`Sistema: ${osName} ${os.release()} ${process.arch}`);
  L.push('');
  L.push('── Claude Code ──');
  const claudePath = await findClaude();
  L.push('Binario: ' + (claudePath || 'NON TROVATO'));
  L.push('');
  L.push('── MCP ──');
  let mcpReg = false;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8'));
    mcpReg = !!(cfg && cfg.mcpServers && cfg.mcpServers['tradingview-mcp']);
  } catch (_) {}
  L.push('tradingview-mcp registrato: ' + (mcpReg ? 'sì' : 'no'));
  if (IS_MAC) {
    L.push('Wrapper ~/.tv2claude_mcp.sh: '
         + (fs.existsSync(path.join(HOME, '.tv2claude_mcp.sh')) ? 'sì' : 'no'));
  }
  L.push('');
  L.push('── TradingView (porta debug 9222) ──');
  const tvUp = await new Promise(r => {
    const http = require('http');
    const req = http.get({host:'127.0.0.1', port:9222, path:'/json/version', timeout:1500},
      res => { res.resume(); r(true); });
    req.on('error', () => r(false));
    req.on('timeout', () => { req.destroy(); r(false); });
  });
  L.push('Raggiungibile: ' + (tvUp ? 'sì' : 'no'));
  L.push('');
  L.push('── Licenza ──');
  L.push('File presente: ' + (fs.existsSync(LICENSE_FILE) ? 'sì' : 'no')
       + '  (chiave non inclusa per privacy)');
  L.push('');
  L.push('── Vault memoria ──');
  try {
    // Stessa logica OneDrive-aware del setDocumentsBase
    let docsBase = path.join(HOME, 'Documents');
    try { docsBase = app.getPath('documents'); } catch (_) {}
    const vault = path.join(docsBase, 'TradingView2Claude Vault');
    if (fs.existsSync(vault)) {
      L.push('Cartella: ' + vault);
      const adir = path.join(vault, 'Analisi');
      const nNotes = fs.existsSync(adir)
        ? fs.readdirSync(adir).filter(f => f.endsWith('.md')).length : 0;
      L.push('Note di analisi: ' + nNotes);
      const cnt = (f) => {
        try { return fs.readFileSync(path.join(vault, f), 'utf8')
                       .split('\n').filter(l => l.startsWith('- ')).length; }
        catch { return 0; }
      };
      L.push('Lezioni: ' + cnt('Lezioni.md'));
      L.push('Previsioni: ' + cnt('Previsioni.md'));
    } else {
      L.push('Vault non ancora creato');
    }
  } catch (e) { L.push('Errore lettura vault: ' + e.message); }

  function tailLog(file, n) {
    try {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      return lines.slice(-n).join('\n');
    } catch { return '(non disponibile)'; }
  }
  L.push('');
  L.push('── Ultime righe del log installer ──');
  L.push(tailLog(LOG_FILE, 80));
  L.push('');
  L.push('── Ultime righe del log chat ──');
  L.push(tailLog(path.join(LOG_DIR, 'chat.log'), 80));

  // OneDrive-aware: app.getPath risolve il vero Desktop dell'utente
  let desktop;
  try { desktop = app.getPath('desktop'); } catch { desktop = path.join(HOME, 'Desktop'); }
  try { desktop = fs.realpathSync(desktop); } catch { /* keep */ }
  if (!fs.existsSync(desktop)) desktop = HOME;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
  const reportPath = path.join(desktop, `TradingView2Claude-Report-${stamp}.txt`);
  fs.writeFileSync(reportPath, L.join('\n'));
  return reportPath;
}

ipcMain.on('diag:generate', async (event) => {
  try {
    const p = await generateDiagnosticReport();
    shell.showItemInFolder(p);
    if (!event.sender.isDestroyed()) event.sender.send('diag:done', { ok: true, path: p });
  } catch (e) {
    writeLog('[diag] errore: ' + e.message);
    if (!event.sender.isDestroyed()) event.sender.send('diag:done', { ok: false, error: e.message });
  }
});

// Handler 'activate'
ipcMain.on('activate', async (event, { key }) => {
  writeLog(`[license] activate richiesto per key: ${key}`);
  try {
    const res = await apiPost({
      action: 'activate',
      license_key: key,
      machine_id: getMachineId(),
      machine_info: `${os.platform()} ${os.arch()} ${os.hostname()}`
    });
    writeLog(`[license] activate response: ${JSON.stringify(res)}`);
    if (res?.ok) {
      saveLicense({ key, customer_name: res.customer_name || '' });
      event.sender.send('lic-result', { ok: true, customer_name: res.customer_name || 'Cliente' });
    } else {
      event.sender.send('lic-result', { ok: false, error: res?.error || 'Chiave non valida' });
    }
  } catch(e) {
    writeLog(`[license] activate error: ${e.message}`);
    event.sender.send('lic-result', { ok: false, error: `Connessione fallita: ${e.message}` });
  }
});

// Handler 'check-license'
ipcMain.on('check-license', async (event) => {
  writeLog('[license] check-license richiesto');
  const saved = loadLicense();
  if (!saved?.key) {
    writeLog('[license] nessuna licenza salvata — mostra schermata licenza');
    event.sender.send('screen', { name: 'license' });
    return;
  }
  try {
    const res = await apiPost({ action: 'validate', license_key: saved.key });
    writeLog(`[license] check response: ${JSON.stringify(res)}`);
    if (res?.ok) {
      event.sender.send('screen', { name: 'install', data: { name: res.customer_name } });
    } else {
      // Licenza sospesa: NON cancellare la chiave — alla riattivazione l'utente
      // non deve reinserirla. Mostra solo avviso.
      event.sender.send('screen', { name: 'license', notice:
        'La licenza non risulta attiva. Se è stata appena riattivata, chiudi e riapri l\'app.' });
    }
  } catch(e) {
    writeLog(`[license] check error (offline): ${e.message}`);
    event.sender.send('screen', { name: 'install', data: { name: saved.customer_name || '' } });
  }
});

ipcMain.on('get-version', (event) => {
  event.sender.send('version', app.getVersion());
});

ipcMain.on('close-app', () => {
  app.quit();
});

// ── Coordinamento motore + dashboard ─────────────────────────────
let engineBusy = false;
function sendDash(channel, payload) {
  if (dashWin && !dashWin.isDestroyed()) dashWin.webContents.send(channel, payload);
}

// ── IPC: Chat dashboard ──────────────────────────────────────────
ipcMain.on('chat:send', (_event, text) => {
  if (engineBusy) return;
  engineBusy = true;
  claudeEngine.ask(String(text || ''), {
    onText:  (t)     => sendDash('claude:text', t),
    onTool:  (label) => sendDash('claude:tool', label),
    onError: (msg)   => { sendDash('claude:error', msg); engineBusy = false; },
    onDone:  ()      => { sendDash('claude:done'); engineBusy = false; },
  });
});

ipcMain.on('chat:reset',     ()              => { claudeEngine.reset(); });
ipcMain.on('chat:set-model', (_e, model)     => { claudeEngine.setModel(model); });
ipcMain.on('chat:set-lang',  (_e, lang)      => { claudeEngine.setLang(lang); });

// ── Briefing programmati ─────────────────────────────────────────
const BRIEFINGS_FILE = path.join(app.getPath('userData'), 'briefings.json');

function loadBriefings() {
  try { return JSON.parse(fs.readFileSync(BRIEFINGS_FILE, 'utf8')) || []; }
  catch { return []; }
}
function saveBriefings(arr) {
  try { fs.mkdirSync(path.dirname(BRIEFINGS_FILE), { recursive: true }); } catch (_) {}
  try { fs.writeFileSync(BRIEFINGS_FILE, JSON.stringify(arr, null, 2)); return true; }
  catch (e) { writeLog('briefings save error: ' + e.message); return false; }
}

const briefingFiredKey = new Map();
function isBriefingDueNow(b, now) {
  if (b.enabled === false) return false;
  const parts = String(b.time || '').split(':').map(Number);
  if (parts.length !== 2 || isNaN(parts[0]) || isNaN(parts[1])) return false;
  if (Array.isArray(b.days) && b.days.length && !b.days.includes(now.getDay())) return false;
  if (now.getHours() !== parts[0] || now.getMinutes() !== parts[1]) return false;
  const key = `${b.id}|${now.toDateString()}|${parts[0]}:${parts[1]}`;
  if (briefingFiredKey.get(b.id) === key) return false;
  briefingFiredKey.set(b.id, key);
  return true;
}

function fireBriefing(b) {
  if (!dashWin || dashWin.isDestroyed()) return;
  if (engineBusy) { writeLog(`[briefing] saltato (motore occupato): ${b.name}`); return; }
  engineBusy = true;
  writeLog(`[briefing] firing: ${b.name || b.id}`);
  sendDash('chat:briefing-start', { name: b.name || 'Briefing programmato' });
  claudeEngine.ask(String(b.prompt || ''), {
    onText:  (t) => sendDash('claude:text', t),
    onTool:  (l) => sendDash('claude:tool', l),
    onError: (m) => { sendDash('claude:error', m); engineBusy = false; },
    onDone:  ()  => { sendDash('claude:done'); engineBusy = false; },
  });
}

let briefingTimer = null;
function startBriefingScheduler() {
  if (briefingTimer) return;
  briefingTimer = setInterval(() => {
    const briefings = loadBriefings();
    if (!briefings.length) return;
    const now = new Date();
    for (const b of briefings) {
      if (isBriefingDueNow(b, now)) { fireBriefing(b); break; }
    }
  }, 60 * 1000);
}

ipcMain.handle('briefings:list', () => loadBriefings());
ipcMain.handle('briefings:save', (_e, arr) => saveBriefings(Array.isArray(arr) ? arr : []));

// ── App lifecycle ────────────────────────────────────────────────
app.whenReady().then(async () => {
  initLog();
  writeLog('=== APP AVVIATA ===');
  writeLog(`Versione: ${app.getVersion()}`);
  writeLog(`Piattaforma: ${process.platform} ${process.arch}`);
  try {
    const memory = require('./memory');
    // Su Windows con OneDrive, Documents è in %USERPROFILE%\OneDrive\Documents
    // — app.getPath('documents') risolve correttamente per ogni configurazione.
    try { memory.setDocumentsBase(app.getPath('documents')); } catch (_) {}
    memory.ensureVault();
  } catch (_) {}

  // File temp per prompt/persona dentro la userData dell'app
  // (più stabile di TEMP, mai pulita dal sistema, sempre scrivibile).
  try { claudeEngine.setTempDir(app.getPath('userData')); } catch (_) {}

  // Node.js bundled — usato su Windows per spawnare DIRETTAMENTE cli.js
  // senza passare per cmd.exe (che rompe il quoting dei prompt multiline).
  try {
    const bn = getBundledNodePath();
    if (bn) claudeEngine.setBundledNode(bn);
  } catch (_) {}

  // Flusso di avvio: dashboard SOLO se licenza valida E setup completo
  // (Claude installato + MCP registrato + utente loggato a Claude).
  // Se manca il login (token revocato, logout, ecc.) torna in setup
  // così l'utente vede l'overlay "Continua" per riaprire il Terminale.
  let goDashboard = false;
  const lic = loadLicense();
  if (lic && lic.key) {
    const status = await verifyLicenseStatus(lic.key);
    writeLog(`[avvio] stato licenza: ${status}`);
    const setupOk = await isSetupComplete();
    const loggedIn = isClaudeLoggedIn();
    writeLog(`[avvio] setupComplete=${setupOk} loggedIn=${loggedIn}`);
    if (status !== 'suspended' && setupOk && loggedIn) {
      goDashboard = true;
    }
  }

  if (goDashboard) {
    writeLog('[avvio] → dashboard');
    createDashboardWindow();
  } else {
    writeLog('[avvio] → setup/licenza');
    createWindow();
  }

  app.on('activate', () => {
    if (!mainWin && !dashWin) createDashboardWindow();
  });

  startBriefingScheduler();
});

app.on('window-all-closed', () => {
  // Su macOS: app resta viva (convenzione). Su Win/Linux: esce.
  if (!IS_MAC) app.quit();
});

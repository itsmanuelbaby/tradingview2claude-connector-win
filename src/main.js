// ================================================================
//  TradingView2Claude Connector — main.js
//  Versione produzione 1.0.0
// ================================================================

'use strict';

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path   = require('path');
const { spawn, exec }  = require('child_process');
const fs     = require('fs');
const os     = require('os');
const crypto = require('crypto');
const https  = require('https');
const http   = require('http');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const HOME   = os.homedir();

// ── CONFIGURAZIONE ────────────────────────────────────────────
// Sostituisci con l'URL del tuo Google Apps Script
const LICENSE_API  = 'https://script.google.com/macros/s/AKfycbyXx0246ZvZtieTHHLUgsG4bbZirOVMGnDgT788bodMVkwjY_6Pnusho2IAL3YSrZSW/exec';
const LICENSE_FILE = path.join(app.getPath('userData'), 'lic.dat');
const SALT         = 'TV2CLAUDE2026';
const APP_VERSION  = '1.0.0';

// ── NODE BUNDLED ──────────────────────────────────────────────
// Ritorna il percorso del binario Node bundled nell'app
function getBundledNode() {
  const arch = os.arch(); // 'arm64' o 'x64'
  const nodeFile = arch === 'arm64' ? 'node-arm64' : 'node-x64';
  const bundledDir = app.isPackaged
    ? path.join(process.resourcesPath, 'bundled-node')
    : path.join(__dirname, '..', 'bundled-node');
  return path.join(bundledDir, nodeFile);
}

// Ritorna il percorso di npm bundled
function getBundledNpm() {
  const bundledDir = app.isPackaged
    ? path.join(process.resourcesPath, 'bundled-node')
    : path.join(__dirname, '..', 'bundled-node');
  return path.join(bundledDir, 'npm');
}

let mainWindow;

// ── FINESTRA PRINCIPALE ───────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 860,
    height: 640,
    minWidth: 860,
    minHeight: 640,
    resizable: false,
    frame: false,
    backgroundColor: '#0D0D0D',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      devTools: false, // disabilita devtools in produzione
    },
    icon: path.join(__dirname, '../assets/icon.png'),
    show: false, // mostra solo dopo ready
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

// ── IPC HELPERS ──────────────────────────────────────────────
const send = (ch, data) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(ch, data);
  }
};
const sendLog      = msg  => { if (msg && msg.trim()) send('log', msg.trim()); };
const sendStep     = (i, s) => send('step', { index: i, status: s });
const sendProgress = pct  => send('progress', pct);
const sendDone     = (ok, msg) => send('done', { ok, msg: msg || '' });
const sendScreen   = (name, data) => send('screen', { name, data: data || {} });
const sendLicRes   = data => send('lic-result', data);

// ── PATH WINDOWS ──────────────────────────────────────────────
// Costruisce PATH esteso per trovare node, npm, git in tutte le location comuni
function buildWinPath() {
  if (!IS_WIN) return {};
  const paths = [
    process.env.PATH,
    process.env.APPDATA    ? `${process.env.APPDATA}\\npm`         : null,
    process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\npm`   : null,
    process.env.ProgramFiles  ? `${process.env.ProgramFiles}\\nodejs`  : null,
    process.env.ProgramFiles  ? `${process.env.ProgramFiles}\\Git\\cmd` : null,
    process.env['ProgramFiles(x86)'] ? `${process.env['ProgramFiles(x86)']}\\nodejs`  : null,
    process.env['ProgramFiles(x86)'] ? `${process.env['ProgramFiles(x86)']}\\Git\\cmd` : null,
  ].filter(Boolean);
  return { PATH: paths.join(';') };
}

// Ricarica PATH dal registro Windows (necessario dopo installazioni)
async function refreshWinPath() {
  if (!IS_WIN) return;
  try {
    const sys = await runQ(`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('PATH','Machine')"`);
    const usr = await runQ(`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('PATH','User')"`);
    const merged = [sys, usr, process.env.PATH].filter(Boolean).join(';');
    if (merged) process.env.PATH = merged;
  } catch (_) { /* non bloccante */ }
}

// ── ESEGUI COMANDO CON LOG ────────────────────────────────────
// opts: { ignoreError, cwd, ...spawnOpts }
function run(cmd, args = [], opts = {}) {
  const { ignoreError = false, cwd, ...spawnOpts } = opts;
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...buildWinPath() };
    const proc = spawn(cmd, args, {
      shell: true,
      env,
      cwd: cwd || HOME,
      ...spawnOpts,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', chunk => {
      const txt = chunk.toString();
      stdout += txt;
      // Filtra linee vuote e rumore di npm
      const lines = txt.split('\n').filter(l => {
        const t = l.trim();
        return t && !t.startsWith('npm warn') && !t.startsWith('npm notice');
      });
      lines.forEach(l => sendLog(l));
    });

    proc.stderr?.on('data', chunk => {
      const txt = chunk.toString();
      stderr += txt;
      // Mostra stderr solo se non è rumore standard
      const lines = txt.split('\n').filter(l => {
        const t = l.trim();
        return t && !t.startsWith('npm warn') && !t.startsWith('npm notice') && !t.includes('deprecated');
      });
      lines.forEach(l => sendLog(l));
    });

    proc.on('close', code => {
      if (code === 0 || ignoreError) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || stdout.trim() || `Processo terminato con codice ${code}`));
    });

    proc.on('error', err => reject(new Error(`Impossibile eseguire "${cmd}": ${err.message}`)));
  });
}

// ── ESEGUI SILENZIOSO (solo output, no log) ───────────────────
function runQ(cmd, timeoutMs = 10000) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    exec(cmd, { env: { ...process.env, ...buildWinPath() } }, (err, stdout) => {
      clearTimeout(timer);
      if (err) resolve(null);
      else resolve((stdout || '').trim() || null);
    });
  });
}

// ── TROVA CLAUDE ─────────────────────────────────────────────
async function findClaude() {
  if (IS_MAC) {
    // Cerca prima con which (più affidabile)
    const w = await runQ('which claude');
    if (w && fs.existsSync(w)) return w;
    // Percorsi comuni su Mac
    const macPaths = [
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
      `${HOME}/.npm-global/bin/claude`,
      `${HOME}/Library/npm/bin/claude`,
    ];
    for (const p of macPaths) if (fs.existsSync(p)) return p;
    return null;
  }

  // Windows: controlla prefix npm prima (più preciso)
  const prefix = await runQ('npm config get prefix');
  const prefixPaths = prefix && prefix !== 'undefined'
    ? [`${prefix}\\claude.cmd`] : [];

  const winPaths = [
    ...prefixPaths,
    process.env.APPDATA    ? `${process.env.APPDATA}\\npm\\claude.cmd`         : null,
    process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\npm\\claude.cmd`   : null,
    process.env.ProgramFiles  ? `${process.env.ProgramFiles}\\nodejs\\claude.cmd` : null,
  ].filter(Boolean);

  for (const p of winPaths) if (fs.existsSync(p)) return p;
  return null;
}

// ── TROVA TRADINGVIEW ────────────────────────────────────────
async function findTradingView() {
  if (IS_WIN) {
    const regPaths = [];

    // Cerca nel registro (metodo più affidabile)
    for (const hive of ['HKCU', 'HKLM']) {
      for (const regPath of [
        `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall`,
        `${hive}\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall`,
      ]) {
        const out = await runQ(`reg query "${regPath}" /s /f "TradingView" 2>nul`);
        if (out) {
          const m = out.match(/InstallLocation\s+REG_SZ\s+(.+)/);
          if (m && m[1].trim()) {
            regPaths.push(m[1].trim() + '\\TradingView.exe');
          }
        }
      }
    }

    const fallbacks = [
      process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Programs\\TradingView\\TradingView.exe` : null,
      process.env.ProgramFiles  ? `${process.env.ProgramFiles}\\TradingView\\TradingView.exe`           : null,
      process.env['ProgramFiles(x86)'] ? `${process.env['ProgramFiles(x86)']}\\TradingView\\TradingView.exe` : null,
    ].filter(Boolean);

    for (const p of [...regPaths, ...fallbacks]) {
      if (p && fs.existsSync(p)) return p;
    }
    return null;
  }

  // Mac
  const macPaths = [
    '/Applications/TradingView.app',
    `${HOME}/Applications/TradingView.app`,
  ];
  for (const p of macPaths) if (fs.existsSync(p)) return p;
  return null;
}

// ── MACHINE ID ───────────────────────────────────────────────
function getMachineId() {
  const parts = [
    os.hostname(),
    os.platform(),
    os.arch(),
    (os.cpus()[0] || {}).model || 'unknown',
    String(os.totalmem()),
  ];
  return crypto
    .createHash('sha256')
    .update(parts.join('|') + SALT)
    .digest('hex')
    .slice(0, 32);
}

// ── API LICENZE ───────────────────────────────────────────────
// HTTP/HTTPS POST con follow redirect automatico
function apiPost(payload, redirectCount = 0) {
  if (redirectCount > 5) return Promise.reject(new Error('Troppi redirect — riprova'));

  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    let url;
    try { url = new URL(LICENSE_API.replace('YOUR_SCRIPT_ID', 'YOUR_SCRIPT_ID')); }
    catch (_) { return reject(new Error('URL licenza non configurato')); }

    // usePost: true per POST iniziale, false per GET dopo redirect 301/302/303
    function doRequest(urlStr, usePost = true) {
      let parsedUrl;
      try { parsedUrl = new URL(urlStr); }
      catch (_) { return reject(new Error('URL non valido: ' + urlStr)); }

      const isHttps = parsedUrl.protocol === 'https:';
      const lib = isHttps ? https : http;

      const method = usePost ? 'POST' : 'GET';
      const headers = { 'Accept': 'application/json' };
      if (usePost) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(body);
      }

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method,
        headers,
        timeout: 20000,
      };

      const req = lib.request(options, res => {
        // Follow redirect
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          // 301/302/303 → standard HTTP: converti a GET (il server non accetta POST sul redirect)
          // 307/308 → mantieni metodo originale
          const nextPost = [307, 308].includes(res.statusCode) ? usePost : false;
          doRequest(res.headers.location, nextPost);
          return;
        }

        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed);
          } catch (_) {
            reject(new Error(`Risposta server non valida (HTTP ${res.statusCode})`));
          }
        });
        res.on('error', err => reject(new Error('Errore lettura risposta: ' + err.message)));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Timeout connessione — verifica internet e riprova'));
      });

      req.on('error', err => {
        reject(new Error('Connessione fallita: ' + err.message));
      });

      if (usePost) req.write(body);
      req.end();
    }

    doRequest(LICENSE_API);
  });
}

// ── LICENZA LOCALE ───────────────────────────────────────────
function saveLicense(data) {
  try {
    const encoded = Buffer.from(JSON.stringify(data)).toString('base64');
    fs.writeFileSync(LICENSE_FILE, encoded, { encoding: 'utf8', mode: 0o600 });
  } catch (_) {}
}

function loadLicense() {
  try {
    if (!fs.existsSync(LICENSE_FILE)) return null;
    const raw = fs.readFileSync(LICENSE_FILE, 'utf8');
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch (_) { return null; }
}

function clearLicense() {
  try { fs.existsSync(LICENSE_FILE) && fs.unlinkSync(LICENSE_FILE); } catch (_) {}
}

// ── IPC: CHECK LICENZA AVVIO ─────────────────────────────────
ipcMain.on('check-license', async () => {
  try {
    const local = loadLicense();
    if (!local || !local.key || !local.machine_id) {
      sendScreen('license'); return;
    }
    if (local.machine_id !== getMachineId()) {
      clearLicense(); sendScreen('license'); return;
    }

    // Verifica online ogni 24h
    const hoursSince = (Date.now() - (local.last_check || 0)) / 3_600_000;
    if (hoursSince > 24) {
      try {
        const res = await apiPost({
          action: 'check',
          license_key: local.key,
          machine_id: local.machine_id,
        });
        if (!res.ok) { clearLicense(); sendScreen('license'); return; }
        saveLicense({ ...local, last_check: Date.now() });
      } catch (_) {
        // Offline — usa cache locale (ok fino a 7 giorni)
        const daysSince = hoursSince / 24;
        if (daysSince > 7) { clearLicense(); sendScreen('license'); return; }
      }
    }

    sendScreen('install', { name: local.customer_name });
  } catch (_) {
    sendScreen('license');
  }
});

// ── IPC: ATTIVA LICENZA ───────────────────────────────────────
ipcMain.on('activate', async (_, { key }) => {
  const cleanKey = (key || '').toUpperCase().trim();

  if (!cleanKey || cleanKey.replace(/-/g, '').length < 16) {
    sendLicRes({ ok: false, error: 'Chiave non valida — formato: CLTV-XXXX-XXXX-XXXX' });
    return;
  }

  try {
    // Fase 1: valida chiave
    const validation = await apiPost({ action: 'validate', license_key: cleanKey });
    if (!validation.ok) {
      sendLicRes({ ok: false, error: validation.error || 'Chiave non valida' });
      return;
    }

    // Fase 2: attiva su questa macchina
    const machineId = getMachineId();
    const activation = await apiPost({
      action: 'activate',
      license_key: cleanKey,
      machine_id: machineId,
      machine_info: `${os.hostname()} — ${os.platform()} ${os.arch()} — Node ${process.versions.node}`,
    });

    if (!activation.ok) {
      sendLicRes({ ok: false, error: activation.error || 'Attivazione fallita' });
      return;
    }

    // Salva localmente
    saveLicense({
      key: cleanKey,
      customer_name: activation.customer_name,
      machine_id: machineId,
      last_check: Date.now(),
      activated_at: Date.now(),
    });

    sendLicRes({ ok: true, customer_name: activation.customer_name });

  } catch (err) {
    sendLicRes({ ok: false, error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
//  PASSI INSTALLAZIONE
// ════════════════════════════════════════════════════════════════

// Step 0 — Verifica sistema operativo e dipendenze base
async function step0_sistema() {
  sendLog(`Sistema: ${IS_WIN ? 'Windows' : 'macOS'} ${os.arch()} (${os.release()})`);
  sendLog(`Node.js runtime: ${process.versions.node}`);

  if (IS_WIN) {
    const wv = await runQ('winget --version');
    if (!wv) {
      throw new Error(
        'winget non trovato sul tuo PC.\n\n' +
        'Soluzione:\n' +
        '1. Apri il Microsoft Store\n' +
        '2. Cerca "App Installer"\n' +
        '3. Installalo e aggiornalo\n' +
        '4. Riavvia questo programma'
      );
    }
    sendLog(`winget ${wv} — OK`);
  }

  if (IS_MAC) {
    // Node è bundled nell'app — verifica che esista
    const bundledNode = getBundledNode();
    if (!fs.existsSync(bundledNode)) {
      throw new Error('Node bundled non trovato. Reinstalla il software.');
    }
    // Rende eseguibile il binario bundled
    fs.chmodSync(bundledNode, 0o755);
    // Aggiunge il bundled-node al PATH di questo processo
    const bundledDir = path.dirname(bundledNode);
    if (!process.env.PATH.includes(bundledDir)) {
      process.env.PATH = bundledDir + ':' + process.env.PATH;
    }
    sendLog('Node bundled pronto — OK');
  }
}

// Step 1 — Node.js (bundled su Mac, winget su Windows)
async function step1_nodejs() {
  if (IS_MAC) {
    // Su Mac usiamo il Node bundled nell'app — già configurato in step0
    const bundledNode = getBundledNode();
    const v = await runQ(`"${bundledNode}" --version`);
    sendLog(`Node.js ${v} (bundled) — OK`);
    return;
  }

  // Windows: verifica o installa tramite winget
  const v = await runQ('node --version');
  if (v) { sendLog(`Node.js ${v} già installato`); return; }

  sendLog('Installazione Node.js LTS in corso...');
  await run('winget', [
    'install', '--id', 'OpenJS.NodeJS.LTS',
    '--silent', '--accept-package-agreements', '--accept-source-agreements',
  ], { ignoreError: true });
  await refreshWinPath();

  const v2 = await runQ('node --version');
  if (!v2) {
    throw new Error(
      'Node.js non trovato dopo installazione.\n' +
      'Soluzione: riavvia il PC e riesegui l\'installer.'
    );
  }
  sendLog(`Node.js ${v2} installato`);
}

// Step 2 — Git (solo Windows, su Mac non serve più)
async function step2_git() {
  if (IS_MAC) {
    sendLog('Git non necessario su Mac — OK');
    return;
  }

  // Windows
  const v = await runQ('git --version');
  if (v) { sendLog(`Git già installato`); return; }

  sendLog('Installazione Git in corso...');
  await run('winget', [
    'install', '--id', 'Git.Git',
    '--silent', '--accept-package-agreements', '--accept-source-agreements',
  ], { ignoreError: true });
  await refreshWinPath();

  const v2 = await runQ('git --version');
  if (!v2) {
    throw new Error(
      'Git non trovato dopo installazione.\n' +
      'Soluzione: riavvia il PC e riesegui l\'installer.'
    );
  }
  sendLog('Git installato');
}

// Step 3 — Claude Code
async function step3_claude() {
  let claudePath = await findClaude();
  if (claudePath) { sendLog('Claude Code già installato'); return claudePath; }

  sendLog('Installazione Claude Code in corso...');

  if (IS_MAC) {
    // Assicura che il node bundled sia nel PATH prima di chiamare npm
    const bundledNode = getBundledNode();
    const bundledDir = path.dirname(bundledNode);
    fs.chmodSync(bundledNode, 0o755);
    // Aggiorna process.env.PATH in modo che run() lo usi
    if (!process.env.PATH.includes(bundledDir)) {
      process.env.PATH = bundledDir + ':' + process.env.PATH;
    }
    // Crea symlink node -> node-arm64/node-x64 se non esiste
    const nodeSymlink = path.join(bundledDir, 'node');
    if (!fs.existsSync(nodeSymlink)) {
      try { fs.symlinkSync(bundledNode, nodeSymlink); } catch(_) {}
    }
    await run('npm', ['install', '-g', '@anthropic-ai/claude-code'], { cwd: HOME });
  } else {
    await run('npm', ['install', '-g', '@anthropic-ai/claude-code'], { cwd: HOME });
  }
  await refreshWinPath();

  // Aspetta un momento per il filesystem
  await new Promise(r => setTimeout(r, 1500));
  claudePath = await findClaude();

  if (!claudePath) {
    throw new Error(
      'Claude Code non trovato dopo installazione.\n' +
      'Soluzione: riavvia il PC e riesegui l\'installer.'
    );
  }
  sendLog('Claude Code installato');
  return claudePath;
}

// Step 4 — TradingView MCP Server (bundled dentro l'app)
async function step4_mcp() {
  const dest = path.join(HOME, 'tradingview-mcp');

  // Percorso dei file MCP bundled dentro l'app Electron
  // In produzione: process.resourcesPath/bundled-mcp
  // In sviluppo: cartella progetto/bundled-mcp
  let bundledMcp = app.isPackaged
    ? path.join(process.resourcesPath, 'bundled-mcp')
    : path.join(__dirname, '..', 'bundled-mcp');

  // Risolvi eventuali symlink (es. quando l'app gira da DMG montato)
  try {
    if (fs.existsSync(bundledMcp)) {
      bundledMcp = fs.realpathSync(bundledMcp);
    }
  } catch (e) { /* ignore */ }

  if (!fs.existsSync(bundledMcp)) {
    // Errore dettagliato che mostra il path effettivamente cercato
    const parent = path.dirname(bundledMcp);
    let dirContents = '';
    try {
      if (fs.existsSync(parent)) {
        dirContents = '\nContenuto cartella: ' + fs.readdirSync(parent).join(', ');
      }
    } catch (e) { /* ignore */ }
    throw new Error(
      'File MCP bundled non trovati. Path cercato: ' + bundledMcp +
      dirContents +
      '\nSe il problema persiste, sposta l\'app in /Applications e riapri.'
    );
  }

  const hasPkg = fs.existsSync(path.join(dest, 'package.json'));

  if (!hasPkg) {
    sendLog('Installazione tradingview-mcp in corso...');
    // Copia i file bundled nella home del cliente
    if (IS_WIN) {
      await run('xcopy', [bundledMcp, dest, '/E', '/I', '/Y', '/Q'], { ignoreError: false });
    } else {
      if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
      await run('cp', ['-r', `"${bundledMcp}/."`, `"${dest}"`], { ignoreError: false });
    }
  } else {
    sendLog('tradingview-mcp già presente');
  }

  // Su Mac i node_modules sono pre-installati nel bundled-mcp
  if (IS_MAC) {
    sendLog('Dipendenze MCP pre-installate — OK');
  } else {
    sendLog('Installazione dipendenze MCP...');
    await run('npm', ['install', '--no-audit', '--prefer-offline'], { cwd: dest });
  }

  sendLog('tradingview-mcp pronto');
  return dest;
}

// Step 5 — Trova TradingView
async function step5_findtv() {
  const p = await findTradingView();
  if (p) sendLog(`TradingView trovato: ${p}`);
  else sendLog('TradingView non trovato — verrà usato il percorso di default');
  return p || null;
}

// Step 6 — Configura server MCP
async function step6_mcp(claudePath, mcpDir) {
  if (!claudePath) throw new Error('Percorso Claude Code non determinato');
  if (!mcpDir)     throw new Error('Directory MCP non determinata');

  // Auto-rileva il file entry point del server MCP
  // Controlla i percorsi più comuni usati dai repo npm/github
  const candidates = [
    path.join(mcpDir, 'index.js'),
    path.join(mcpDir, 'src', 'server.js'),
    path.join(mcpDir, 'src', 'index.js'),
    path.join(mcpDir, 'dist', 'index.js'),
    path.join(mcpDir, 'dist', 'server.js'),
    path.join(mcpDir, 'server.js'),
    path.join(mcpDir, 'app.js'),
  ];

  // Controlla anche il campo "main" nel package.json del repo
  let indexPath = null;
  try {
    const pkgJson = JSON.parse(fs.readFileSync(path.join(mcpDir, 'package.json'), 'utf8'));
    if (pkgJson.main) {
      const mainPath = path.join(mcpDir, pkgJson.main);
      if (fs.existsSync(mainPath)) indexPath = mainPath;
    }
    // Controlla anche bin e scripts.start
    if (!indexPath && pkgJson.bin) {
      const binVal = typeof pkgJson.bin === 'string' ? pkgJson.bin : Object.values(pkgJson.bin)[0];
      if (binVal) {
        const binPath = path.join(mcpDir, binVal);
        if (fs.existsSync(binPath)) indexPath = binPath;
      }
    }
  } catch (_) {}

  // Fallback: cerca tra i candidati standard
  if (!indexPath) {
    for (const c of candidates) {
      if (fs.existsSync(c)) { indexPath = c; break; }
    }
  }

  if (!indexPath) {
    // Ultima spiaggia: cerca qualsiasi .js nella root
    const rootFiles = fs.readdirSync(mcpDir).filter(f => f.endsWith('.js'));
    if (rootFiles.length > 0) indexPath = path.join(mcpDir, rootFiles[0]);
  }

  if (!indexPath) {
    throw new Error(`File MCP non trovato in: ${mcpDir}\nCartella contiene: ${fs.readdirSync(mcpDir).join(', ')}`);
  }

  sendLog(`Entry point MCP: ${path.basename(indexPath)}`);

  await run(
    IS_WIN ? `"${claudePath}"` : claudePath,
    ['mcp', 'add', 'tradingview', '--', 'node', indexPath],
    { cwd: HOME, ignoreError: true }
  );
  sendLog('Server MCP configurato');
}

// Step 7 — Crea launcher sul Desktop
async function step7_launcher(claudePath, tvPath, mcpDir) {
  if (!claudePath) throw new Error('Percorso Claude Code non determinato');

  const desktop = path.join(HOME, 'Desktop');
  if (!fs.existsSync(desktop)) {
    fs.mkdirSync(desktop, { recursive: true });
  }

  if (IS_WIN) {
    // Usa variabili bat native per PATH (non hardcodare percorsi)
    // Usa il percorso claude reale trovato durante installazione
    const tvExe = tvPath
      ? `"${tvPath}"`
      : `"%LOCALAPPDATA%\\Programs\\TradingView\\TradingView.exe"`;

    const claudeExe = `"${claudePath}"`;

    const lines = [
      '@echo off',
      'setlocal',
      'title TradingView2Claude Connector',
      'cls',
      '',
      ':: Aggiunge percorsi npm e nodejs al PATH',
      'set "PATH=%ProgramFiles%\\nodejs;%APPDATA%\\npm;%LOCALAPPDATA%\\npm;%ProgramFiles%\\Git\\cmd;%PATH%"',
      '',
      'echo.',
      'echo  +==============================================+',
      'echo  ^|      TradingView2Claude Connector          ^|',
      'echo  +==============================================+',
      'echo.',
      '',
      'echo  [1/3] Chiusura TradingView...',
      'taskkill /f /im TradingView.exe >nul 2>&1',
      'timeout /t 2 /nobreak >nul',
      '',
      'echo  [2/3] Apertura TradingView con porta debug...',
      `start "" ${tvExe} --remote-debugging-port=9222`,
      'timeout /t 5 /nobreak >nul',
      'echo  [OK] TradingView avviato',
      '',
      'echo  [3/3] Avvio Claude Code...',
      'echo.',
      'echo  Digita il tuo prompt di analisi e premi INVIO',
      'echo  Esempio: Analizza il grafico attuale, dimmi supporti e resistenze',
      'echo.',
      `cd /d "${mcpDir}"`,
      claudeExe,
      '',
      'endlocal',
      'pause',
    ];

    const launcherPath = path.join(desktop, 'Avvia TradingView2Claude.bat');
    fs.writeFileSync(launcherPath, lines.join('\r\n'), { encoding: 'utf8' });

  } else {
    // Mac — percorso TradingView
    const tvApp = tvPath || '/Applications/TradingView.app';
    // Determina comando open corretto
    const openCmd = fs.existsSync(tvApp)
      ? `open "${tvApp}" --args --remote-debugging-port=9222`
      : `open -a "TradingView" --args --remote-debugging-port=9222`;

    const bundledDir = path.dirname(getBundledNode());
    const lines = [
      '#!/bin/bash',
      '',
      `export PATH="${bundledDir}:$PATH"`,
      '',
      'clear',
      'echo ""',
      'echo "  +==============================================+"',
      'echo "  |      TradingView2Claude Connector          |"',
      'echo "  +==============================================+"',
      'echo ""',
      '',
      '# Verifica login Anthropic',
      `if ! "${claudePath}" --print "test" >/dev/null 2>&1; then`,
      '  echo "  [LOGIN] Accesso ad Anthropic richiesto..."',
      '  echo ""',
      `  "${claudePath}" /login`,
      '  echo ""',
      'fi',
      '',
      'echo "  [1/3] Chiusura TradingView..."',
      'pkill -f "TradingView" 2>/dev/null',
      'sleep 1',
      '',
      'echo "  [2/3] Apertura TradingView con porta debug..."',
      openCmd,
      'sleep 4',
      'echo "  [OK] TradingView avviato"',
      '',
      'echo "  [3/3] Avvio Claude Code..."',
      'echo ""',
      'echo "  Digita il tuo prompt di analisi e premi INVIO"',
      'echo "  Esempio: Analizza il grafico attuale"',
      'echo ""',
      `cd "${mcpDir}"`,
      `"${claudePath}"`,
      '',
    ];

    const launcherPath = path.join(desktop, 'Avvia TradingView2Claude.command');
    fs.writeFileSync(launcherPath, lines.join('\n'), { encoding: 'utf8' });
    fs.chmodSync(launcherPath, '755');
  }

  sendLog('Launcher creato sul Desktop');
}

// ── IPC: AVVIA INSTALLAZIONE ──────────────────────────────────
ipcMain.on('start-install', async () => {
  let claudePath = null;
  let mcpDir     = null;
  let tvPath     = null;

  const steps = [
    { fn: step0_sistema },
    { fn: step1_nodejs  },
    { fn: step2_git     },
    { fn: step3_claude  },  // → claudePath
    { fn: step4_mcp     },  // → mcpDir
    { fn: step5_findtv  },  // → tvPath
  ];

  try {
    for (let i = 0; i < steps.length; i++) {
      sendStep(i, 'running');
      sendProgress(Math.round((i / 8) * 100));

      const result = await steps[i].fn();

      if (i === 3) claudePath = result;
      if (i === 4) mcpDir     = result;
      if (i === 5) tvPath     = result;

      sendStep(i, 'done');
    }

    // Step 6: Configura MCP
    sendStep(6, 'running');
    sendProgress(88);
    await step6_mcp(claudePath, mcpDir);
    sendStep(6, 'done');

    // Step 7: Crea Launcher
    sendStep(7, 'running');
    sendProgress(95);
    await step7_launcher(claudePath, tvPath, mcpDir);
    sendStep(7, 'done');

    sendProgress(100);
    sendDone(true);

  } catch (err) {
    sendLog('');
    sendLog('══ ERRORE: ' + err.message);
    sendDone(false, err.message);
  }
});

// ── IPC: COMANDI UI ──────────────────────────────────────────
ipcMain.on('close-app', () => app.quit());

ipcMain.on('open-launcher', () => {
  const desktop = path.join(HOME, 'Desktop');
  const file = IS_WIN
    ? path.join(desktop, 'Avvia TradingView2Claude.bat')
    : path.join(desktop, 'Avvia TradingView2Claude.command');

  if (fs.existsSync(file)) {
    shell.openPath(file);
  } else {
    sendLog('Launcher non trovato sul Desktop — reinstalla');
  }
});

ipcMain.on('get-version', () => {
  send('version', APP_VERSION);
});

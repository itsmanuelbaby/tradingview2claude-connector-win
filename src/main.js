'use strict';

// ================================================================
//  TradingView2Claude Connector — main.js (WINDOWS)
//  TradingView via Chrome/Edge con CDP — nessuna dipendenza MSIX
// ================================================================

const { app, BrowserWindow, ipcMain, shell, net } = require('electron');
const path   = require('path');
const { spawn, exec } = require('child_process');
const fs     = require('fs');
const os     = require('os');
const crypto = require('crypto');

const HOME = os.homedir();

// ── CONFIGURAZIONE ────────────────────────────────────────────
const LICENSE_API  = 'https://script.google.com/macros/s/AKfycbyXx0246ZvZtieTHHLUgsG4bbZirOVMGnDgT788bodMVkwjY_6Pnusho2IAL3YSrZSW/exec';
const LICENSE_FILE = path.join(app.getPath('userData'), 'lic.dat');
const APP_VERSION  = '1.0.0';

// ── FINESTRA PRINCIPALE ───────────────────────────────────────
let mainWin = null;

function createWindow() {
  mainWin = new BrowserWindow({
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
      devTools: false,
    },
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    show: false,
  });
  mainWin.loadFile(path.join(__dirname, 'index.html'));
  mainWin.once('ready-to-show', () => mainWin.show());
  mainWin.on('closed', () => { mainWin = null; });
}

// ── IPC HELPERS ──────────────────────────────────────────────
const send = (ch, data) => {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(ch, data);
};
const sendLog      = msg       => { if (msg && msg.trim()) send('log', msg.trim()); };
const sendStep     = (i, s)    => send('step', { index: i, status: s });
const sendProgress = pct       => send('progress', pct);
const sendDone     = (ok, msg) => send('done', { ok, msg: msg || '' });

// ── PATH WINDOWS ──────────────────────────────────────────────
function buildWinPath() {
  const parts = [
    process.env.PATH,
    process.env.APPDATA     ? path.join(process.env.APPDATA, 'npm')              : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'npm')        : null,
    process.env.ProgramFiles  ? path.join(process.env.ProgramFiles, 'nodejs')    : null,
    process.env.ProgramFiles  ? path.join(process.env.ProgramFiles, 'Git', 'cmd'): null,
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'nodejs')    : null,
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'Git', 'cmd'): null,
  ].filter(Boolean);
  return { PATH: parts.join(';') };
}

async function refreshWinPath() {
  try {
    const sys = await runQ('powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable(\'PATH\',\'Machine\')"');
    const usr = await runQ('powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable(\'PATH\',\'User\')"');
    const merged = [sys, usr, process.env.PATH].filter(Boolean).join(';');
    if (merged) process.env.PATH = merged;
  } catch (_) {}
}

// ── ESEGUI CON LOG ───────────────────────────────────────────
function run(cmd, args = [], opts = {}) {
  const { ignoreError = false, cwd, env } = opts;
  return new Promise((resolve, reject) => {
    const mergedEnv = { ...process.env, ...buildWinPath(), ...env };
    const proc = spawn(cmd, args, { shell: true, env: mergedEnv, cwd: cwd || HOME });
    let stdout = '', stderr = '';

    proc.stdout?.on('data', chunk => {
      const txt = chunk.toString();
      stdout += txt;
      txt.split('\n').filter(l => {
        const t = l.trim();
        return t && !t.startsWith('npm warn') && !t.startsWith('npm notice');
      }).forEach(l => sendLog(l));
    });

    proc.stderr?.on('data', chunk => {
      const txt = chunk.toString();
      stderr += txt;
      txt.split('\n').filter(l => {
        const t = l.trim();
        return t && !t.startsWith('npm warn') && !t.startsWith('npm notice') && !t.includes('deprecated');
      }).forEach(l => sendLog(l));
    });

    proc.on('close', code => {
      if (code === 0 || ignoreError) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || stdout.trim() || `Processo terminato con codice ${code}`));
    });
    proc.on('error', err => reject(new Error(`Impossibile eseguire "${cmd}": ${err.message}`)));
  });
}

// ── ESEGUI SILENZIOSO ─────────────────────────────────────────
function runQ(cmd, timeoutMs = 10000) {
  return new Promise(resolve => {
    exec(cmd, { env: { ...process.env, ...buildWinPath() }, timeout: timeoutMs }, (err, stdout) => {
      resolve(err ? null : (stdout || '').trim() || null);
    });
  });
}

// ── MACHINE ID (Windows) ─────────────────────────────────────
function getMachineId() {
  try {
    const { execSync } = require('child_process');
    const out = execSync(
      'reg query HKLM\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid',
      { encoding: 'utf8', timeout: 5000 }
    );
    const m = out.match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/i);
    if (m && m[1].trim()) {
      return crypto.createHash('sha256').update(m[1].trim()).digest('hex').substring(0, 32);
    }
  } catch (_) {}
  return crypto.createHash('sha256')
    .update(os.hostname() + os.userInfo().username)
    .digest('hex').substring(0, 32);
}

// ── LICENSE API ───────────────────────────────────────────────
// net.fetch (Electron 21+): usa Chromium network stack, segue redirect automaticamente.
async function apiPost(payload) {
  const res = await net.fetch(LICENSE_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  return json;
}

function saveLicense(data) { try { fs.writeFileSync(LICENSE_FILE, JSON.stringify(data)); } catch (_) {} }
function loadLicense()     { try { return JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf8')); } catch { return null; } }
function clearLicense()    { try { fs.unlinkSync(LICENSE_FILE); } catch (_) {} }

// ── TROVA CLAUDE ──────────────────────────────────────────────
async function findClaude() {
  const prefix = await runQ('npm config get prefix');
  const candidates = [
    prefix && prefix !== 'undefined' ? path.join(prefix, 'claude.cmd') : null,
    process.env.APPDATA      ? path.join(process.env.APPDATA, 'npm', 'claude.cmd')      : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'npm', 'claude.cmd') : null,
    process.env.ProgramFiles  ? path.join(process.env.ProgramFiles, 'nodejs', 'claude.cmd')            : null,
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'nodejs', 'claude.cmd') : null,
  ].filter(Boolean);

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  const w = await runQ('where claude 2>nul');
  if (w) {
    const first = w.split('\n')[0].trim();
    if (first && fs.existsSync(first)) return first;
  }
  return null;
}

// ── TROVA NODE.EXE ────────────────────────────────────────────
async function findNode() {
  const candidates = [
    process.env.ProgramFiles  ? path.join(process.env.ProgramFiles, 'nodejs', 'node.exe')                            : null,
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'nodejs', 'node.exe')            : null,
    process.env.LOCALAPPDATA  ? path.join(process.env.LOCALAPPDATA, 'Programs', 'nodejs', 'node.exe')                : null,
    process.env.LOCALAPPDATA  ? path.join(process.env.LOCALAPPDATA, 'PortableNode', 'node-v22.11.0-win-x64', 'node.exe') : null,
  ].filter(Boolean);

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  const w = await runQ('where node 2>nul');
  if (w) {
    const first = w.split('\n')[0].trim();
    if (first && fs.existsSync(first)) return first;
  }
  return 'node';
}

// ── TROVA BROWSER (Chrome / Edge) ────────────────────────────
async function findBrowser() {
  const candidates = [
    process.env.ProgramFiles         ? path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe')          : null,
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
    process.env.LOCALAPPDATA         ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')          : null,
    process.env.ProgramFiles         ? path.join(process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe')          : null,
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe') : null,
    process.env.LOCALAPPDATA         ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe')          : null,
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);

  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

// ── STEP 0: Sistema ───────────────────────────────────────────
async function step0_sistema() {
  sendLog(`Sistema: Windows ${os.arch()} (${os.release()})`);
  sendLog(`Node.js runtime: ${process.versions.node}`);
  const wv = await runQ('winget --version');
  if (!wv) {
    throw new Error(
      'winget non trovato.\n\n' +
      'Soluzione:\n' +
      '1. Apri il Microsoft Store\n' +
      '2. Cerca "App Installer"\n' +
      '3. Installalo e aggiornalo\n' +
      '4. Riavvia questo programma'
    );
  }
  sendLog(`winget ${wv} — OK`);
}

// ── STEP 1: Node.js ───────────────────────────────────────────
async function step1_nodejs() {
  const v = await runQ('node --version');
  if (v) { sendLog(`Node.js ${v} già installato`); return; }

  // Metodo 1: winget
  sendLog('Installazione Node.js LTS via winget...');
  await run('winget', [
    'install', '--id', 'OpenJS.NodeJS.LTS',
    '--source', 'winget', '--silent',
    '--accept-package-agreements', '--accept-source-agreements',
  ], { ignoreError: true });
  await refreshWinPath();
  let v2 = await runQ('node --version');
  if (v2) { sendLog(`Node.js ${v2} installato (winget)`); return; }

  // Metodo 2: MSI da nodejs.org
  sendLog('winget fallito — scarico Node.js MSI...');
  try {
    const tmpDir  = process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp';
    const msiPath = path.join(tmpDir, 'nodejs-lts.msi');
    sendLog('Download in corso (~30 MB)...');
    await run('powershell', [
      '-nologo', '-noprofile', '-command',
      `Invoke-WebRequest -Uri 'https://nodejs.org/dist/v22.11.0/node-v22.11.0-x64.msi' -OutFile '${msiPath}' -UseBasicParsing`,
    ]);
    if (!fs.existsSync(msiPath)) throw new Error('File MSI non scaricato');
    sendLog('Installazione MSI in corso...');
    await run('msiexec', ['/i', msiPath, '/quiet', '/norestart', 'ADDLOCAL=ALL']);
    await refreshWinPath();
    v2 = await runQ('node --version');
    if (v2) { sendLog(`Node.js ${v2} installato (MSI)`); return; }
  } catch (e) {
    sendLog(`MSI fallito: ${e.message}`);
  }

  // Metodo 3: ZIP portable
  sendLog('MSI fallito — provo ZIP portable...');
  try {
    const tmpDir     = process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp';
    const zipPath    = path.join(tmpDir, 'node-portable.zip');
    const installDir = path.join(process.env.LOCALAPPDATA || tmpDir, 'PortableNode');
    sendLog('Download Node.js portable (~30 MB)...');
    await run('powershell', [
      '-nologo', '-noprofile', '-command',
      `Invoke-WebRequest -Uri 'https://nodejs.org/dist/v22.11.0/node-v22.11.0-win-x64.zip' -OutFile '${zipPath}' -UseBasicParsing`,
    ]);
    if (fs.existsSync(zipPath)) {
      sendLog('Estrazione...');
      await run('powershell', [
        '-nologo', '-noprofile', '-command',
        `Expand-Archive -Path '${zipPath}' -DestinationPath '${installDir}' -Force`,
      ]);
      const portableDir  = path.join(installDir, 'node-v22.11.0-win-x64');
      const portableNode = path.join(portableDir, 'node.exe');
      if (fs.existsSync(portableNode)) {
        process.env.PATH = portableDir + ';' + (process.env.PATH || '');
        v2 = await runQ(`"${portableNode}" --version`);
        if (v2) { sendLog(`Node.js ${v2} installato (portable)`); return; }
      }
    }
  } catch (e) {
    sendLog(`ZIP portable fallito: ${e.message}`);
  }

  throw new Error(
    'Impossibile installare Node.js automaticamente.\n' +
    'Scaricalo manualmente da: https://nodejs.org/\n' +
    "Poi riesegui l'installer."
  );
}

// ── STEP 2: Git ───────────────────────────────────────────────
async function step2_git() {
  const v = await runQ('git --version');
  if (v) { sendLog('Git già installato'); return; }

  sendLog('Installazione Git via winget...');
  await run('winget', [
    'install', '--id', 'Git.Git',
    '--source', 'winget', '--silent',
    '--accept-package-agreements', '--accept-source-agreements',
  ], { ignoreError: true });
  await refreshWinPath();
  const v2 = await runQ('git --version');
  if (v2) { sendLog('Git installato (winget)'); return; }

  // Git Portable
  sendLog('winget fallito — scarico Git Portable...');
  try {
    const tmpDir     = process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp';
    const zipPath    = path.join(tmpDir, 'PortableGit.7z.exe');
    const installDir = path.join(process.env.LOCALAPPDATA || tmpDir, 'PortableGit');
    sendLog('Download Git Portable (~50 MB)...');
    await run('powershell', [
      '-nologo', '-noprofile', '-command',
      `Invoke-WebRequest -Uri 'https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.1/PortableGit-2.47.1-64-bit.7z.exe' -OutFile '${zipPath}' -UseBasicParsing`,
    ]);
    if (fs.existsSync(zipPath)) {
      sendLog('Estrazione Git Portable...');
      await run(zipPath, [`-o${installDir}`, '-y'], { ignoreError: false });
      const gitExe = path.join(installDir, 'cmd', 'git.exe');
      if (fs.existsSync(gitExe)) {
        process.env.PATH = path.join(installDir, 'cmd') + ';' + (process.env.PATH || '');
        sendLog('Git installato (portable)');
        return;
      }
    }
  } catch (e) {
    sendLog(`Git portable fallito: ${e.message}`);
  }

  throw new Error(
    'Impossibile installare Git automaticamente.\n' +
    'Scaricalo manualmente da: https://git-scm.com/\n' +
    "Poi riesegui l'installer."
  );
}

// ── STEP 3: Claude Code ───────────────────────────────────────
async function step3_claude() {
  let claudePath = await findClaude();
  if (claudePath) { sendLog('Claude Code già installato'); return claudePath; }

  sendLog('Installazione Claude Code in corso...');

  const npmCandidates = [
    process.env.ProgramFiles  ? path.join(process.env.ProgramFiles, 'nodejs', 'npm.cmd') : null,
    process.env.APPDATA       ? path.join(process.env.APPDATA, 'npm', 'npm.cmd')          : null,
    process.env.LOCALAPPDATA  ? path.join(process.env.LOCALAPPDATA, 'npm', 'npm.cmd')     : null,
    'npm',
  ].filter(Boolean);

  let npmBin = 'npm';
  for (const p of npmCandidates) {
    if (p === 'npm') break;
    if (fs.existsSync(p)) { npmBin = p; break; }
  }

  await run(npmBin, ['install', '-g', '@anthropic-ai/claude-code'], { cwd: HOME });
  await refreshWinPath();

  // Aspetta che npm completi la scrittura
  await new Promise(r => setTimeout(r, 3000));
  claudePath = await findClaude();
  if (!claudePath) {
    await new Promise(r => setTimeout(r, 5000));
    await refreshWinPath();
    claudePath = await findClaude();
  }

  if (!claudePath) throw new Error(
    "Claude Code non trovato dopo l'installazione.\n" +
    'Possibili cause:\n' +
    '  1. npm install ha avuto problemi di rete\n' +
    '  2. Antivirus ha bloccato l\'installazione globale\n' +
    '  3. Permessi mancanti sulla cartella npm globale\n' +
    'Soluzione: riavvia il PC e riesegui l\'installer.'
  );

  sendLog('Claude Code installato');
  return claudePath;
}

// ── STEP 4: TradingView MCP ───────────────────────────────────
async function step4_mcp() {
  const dest = path.join(HOME, 'tradingview-mcp');
  let bundledMcp = app.isPackaged
    ? path.join(process.resourcesPath, 'bundled-mcp')
    : path.join(__dirname, '..', 'bundled-mcp');
  try {
    if (fs.existsSync(bundledMcp)) bundledMcp = fs.realpathSync(bundledMcp);
  } catch (_) {}

  if (!fs.existsSync(bundledMcp)) {
    throw new Error(
      'File MCP bundled non trovati.\n' +
      `Path cercato: ${bundledMcp}\n` +
      'Reinstalla il software.'
    );
  }

  const hasPkg = fs.existsSync(path.join(dest, 'package.json'));
  if (!hasPkg) {
    sendLog('Installazione tradingview-mcp in corso...');
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    await run('xcopy', [bundledMcp, dest, '/E', '/I', '/Y', '/Q'], { ignoreError: false });
  } else {
    sendLog('tradingview-mcp già presente');
  }

  // Se node_modules è già bundled (workflow installa prima del build), evita npm install
  const hasMods = fs.existsSync(path.join(dest, 'node_modules'));
  if (hasMods) {
    sendLog('Dipendenze MCP pre-installate — OK');
  } else {
    sendLog('Installazione dipendenze MCP...');
    await run('npm', ['install', '--no-audit', '--prefer-offline'], { cwd: dest });
  }

  sendLog('tradingview-mcp pronto');
  return dest;
}

// ── STEP 5: Trova browser ─────────────────────────────────────
async function step5_findbrowser() {
  sendLog('Ricerca Google Chrome o Microsoft Edge...');
  const browser = await findBrowser();
  if (browser) {
    const name = /chrome/i.test(browser) ? 'Google Chrome' : 'Microsoft Edge';
    sendLog(`Browser trovato: ${name}`);
    sendLog(`Path: ${browser}`);
  } else {
    sendLog('ATTENZIONE: nessun browser trovato');
    sendLog('Installa Google Chrome: https://www.google.com/chrome/');
  }
  return browser;
}

// ── STEP 6: Registra MCP ─────────────────────────────────────
async function step6_mcp(claudePath, mcpDir) {
  if (!claudePath) throw new Error('Percorso Claude Code non determinato');
  if (!mcpDir)     throw new Error('Directory MCP non determinata');

  const candidates = [
    path.join(mcpDir, 'src', 'server.js'),
    path.join(mcpDir, 'src', 'index.js'),
    path.join(mcpDir, 'server.js'),
    path.join(mcpDir, 'index.js'),
    path.join(mcpDir, 'dist', 'server.js'),
    path.join(mcpDir, 'dist', 'index.js'),
  ];

  let indexPath = null;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(mcpDir, 'package.json'), 'utf8'));
    if (pkg.main) {
      const mp = path.join(mcpDir, pkg.main);
      if (fs.existsSync(mp)) indexPath = mp;
    }
  } catch (_) {}

  if (!indexPath) {
    for (const c of candidates) {
      if (fs.existsSync(c)) { indexPath = c; break; }
    }
  }

  if (!indexPath) {
    const rootJs = fs.readdirSync(mcpDir).filter(f => f.endsWith('.js'));
    if (rootJs.length) indexPath = path.join(mcpDir, rootJs[0]);
  }

  if (!indexPath) throw new Error(`File MCP server non trovato in: ${mcpDir}`);

  sendLog(`Entry point MCP: ${path.basename(indexPath)}`);
  const nodeBin = await findNode();

  for (const oldName of ['tradingview', 'tradingview-mcp']) {
    await run(claudePath, ['mcp', 'remove', oldName], { cwd: HOME, ignoreError: true });
  }
  await run(claudePath, ['mcp', 'add', 'tradingview-mcp', '--', nodeBin, indexPath], { cwd: HOME, ignoreError: true });

  try {
    const out = await runQ(`"${claudePath}" mcp list`);
    if (out && out.includes('tradingview-mcp')) {
      sendLog('Server MCP configurato correttamente');
    } else {
      sendLog('ATTENZIONE: verifica registrazione con: claude mcp list');
    }
  } catch (_) {
    sendLog('Server MCP configurato');
  }
}

// ── STEP 7: Crea Launcher (.bat) ──────────────────────────────
async function step7_launcher(claudePath, browserPath, mcpDir) {
  if (!claudePath) throw new Error('Percorso Claude Code non determinato');

  const desktop = path.join(HOME, 'Desktop');
  if (!fs.existsSync(desktop)) fs.mkdirSync(desktop, { recursive: true });

  const nodeBin = await findNode();

  // Trova entry point MCP
  const mcpEntryPath =
    fs.existsSync(path.join(mcpDir, 'src', 'server.js')) ? path.join(mcpDir, 'src', 'server.js') :
    fs.existsSync(path.join(mcpDir, 'src', 'index.js'))  ? path.join(mcpDir, 'src', 'index.js')  :
    fs.existsSync(path.join(mcpDir, 'index.js'))         ? path.join(mcpDir, 'index.js')          :
    path.join(mcpDir, 'src', 'server.js');

  // PATH completo da iniettare in ogni nuova finestra cmd
  const PATH_LINE = [
    'set "TV2C_PATH=%ProgramFiles%\\nodejs',
    '%LOCALAPPDATA%\\Programs\\nodejs',
    '%APPDATA%\\npm',
    '%LOCALAPPDATA%\\npm',
    '%LOCALAPPDATA%\\PortableGit\\cmd',
    '%ProgramFiles%\\Git\\cmd',
    '%SystemRoot%\\System32',
    '%SystemRoot%"',
  ].join(';');

  // Fallback browser nel caso il percorso rilevato non esista più
  const chromeFallbacks = [
    'if not defined BROWSER_EXE if exist "%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe" set "BROWSER_EXE=%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe"',
    'if not defined BROWSER_EXE if exist "%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe" set "BROWSER_EXE=%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe"',
    'if not defined BROWSER_EXE if exist "%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe" set "BROWSER_EXE=%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe"',
    'if not defined BROWSER_EXE if exist "%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe" set "BROWSER_EXE=%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe"',
    'if not defined BROWSER_EXE if exist "%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe" set "BROWSER_EXE=%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe"',
    'if not defined BROWSER_EXE if exist "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe" set "BROWSER_EXE=C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"',
  ];

  const lines = [
    '@echo off',
    'setlocal enabledelayedexpansion',
    'title TradingView2Claude Connector',
    'cls',
    '',
    ':: PATH esteso: nodejs, npm, git, system',
    PATH_LINE,
    'set "PATH=%TV2C_PATH%;%PATH%"',
    '',
    'echo.',
    'echo  +==============================================+',
    'echo  ^|      TradingView2Claude Connector          ^|',
    'echo  +==============================================+',
    'echo.',
    '',
    ':: ── Trova node.exe ───────────────────────────────────────────────',
    'set "NODE_EXE="',
    ...(nodeBin !== 'node' ? [`if exist "${nodeBin}" set "NODE_EXE=${nodeBin}"`] : []),
    'if not defined NODE_EXE if exist "%ProgramFiles%\\nodejs\\node.exe" set "NODE_EXE=%ProgramFiles%\\nodejs\\node.exe"',
    'if not defined NODE_EXE if exist "%LOCALAPPDATA%\\Programs\\nodejs\\node.exe" set "NODE_EXE=%LOCALAPPDATA%\\Programs\\nodejs\\node.exe"',
    'if not defined NODE_EXE if exist "%LOCALAPPDATA%\\PortableNode\\node-v22.11.0-win-x64\\node.exe" set "NODE_EXE=%LOCALAPPDATA%\\PortableNode\\node-v22.11.0-win-x64\\node.exe"',
    'if not defined NODE_EXE set "NODE_EXE=node"',
    '',
    ':: ── Trova claude.cmd ─────────────────────────────────────────────',
    'set "CLAUDE_EXE="',
    `if exist "${claudePath}" set "CLAUDE_EXE=${claudePath}"`,
    'if not defined CLAUDE_EXE for /f "delims=" %%c in (\'where claude 2^>nul\') do if not defined CLAUDE_EXE set "CLAUDE_EXE=%%c"',
    'if not defined CLAUDE_EXE (',
    '  echo  X Claude Code non trovato. Reinstalla il software.',
    '  pause',
    '  exit /b 1',
    ')',
    '',
    ':: ── Registra MCP (idempotente) ──────────────────────────────────',
    `if not exist "${mcpEntryPath}" (`,
    '  echo  X File MCP server non trovato. Reinstalla il software.',
    '  pause',
    '  exit /b 1',
    ')',
    'call "%CLAUDE_EXE%" mcp remove tradingview >nul 2>&1',
    'call "%CLAUDE_EXE%" mcp remove tradingview-mcp >nul 2>&1',
    `call "%CLAUDE_EXE%" mcp add tradingview-mcp -- "%NODE_EXE%" "${mcpEntryPath}" >nul 2>&1`,
    '',
    ':: ── Chiudi sessioni debug precedenti sulla porta 9222 ────────────',
    'for /f "tokens=5" %%p in (\'%SystemRoot%\\System32\\netstat.exe -ano 2^>nul ^| findstr ":9222 "\') do taskkill /f /pid %%p >nul 2>&1',
    'timeout /t 1 /nobreak >nul',
    '',
    ':: ── Trova browser ────────────────────────────────────────────────',
    'set "BROWSER_EXE="',
    ...(browserPath ? [`if exist "${browserPath}" set "BROWSER_EXE=${browserPath}"`] : []),
    ...chromeFallbacks,
    'if not defined BROWSER_EXE (',
    '  echo  X Nessun browser trovato.',
    '  echo    Installa Google Chrome: https://www.google.com/chrome/',
    '  pause',
    '  exit /b 1',
    ')',
    '',
    ':: ── Apri TradingView in Chrome/Edge (tab normale, CDP abilitato) ──',
    'echo  [1/2] Apertura TradingView nel browser...',
    'set "CDP_PROFILE=%USERPROFILE%\\tv2claude-browser-profile"',
    'if not exist "%CDP_PROFILE%" mkdir "%CDP_PROFILE%"',
    // Nessun --app= : apre una scheda normale con barra degli indirizzi
    'start "" "%BROWSER_EXE%" --remote-debugging-port=9222 --user-data-dir="%CDP_PROFILE%" --no-first-run --no-default-browser-check "https://www.tradingview.com"',
    '',
    ':: ── Attendi che il CDP sia raggiungibile (max 40 sec) ───────────',
    'set "CDP_READY=0"',
    'set "RETRY=0"',
    ':WAIT_CDP',
    'timeout /t 2 /nobreak >nul',
    '%SystemRoot%\\System32\\curl.exe -s --max-time 2 http://localhost:9222/json/version >nul 2>&1 && set "CDP_READY=1"',
    'if "%CDP_READY%"=="1" goto CDP_OK',
    'set /a RETRY+=1',
    'if %RETRY% lss 20 goto WAIT_CDP',
    'echo.',
    'echo  ATTENZIONE: browser non risponde sulla porta 9222.',
    'echo  Cause possibili:',
    'echo    1. Antivirus o firewall blocca la porta locale 9222',
    'echo    2. Il browser e bloccato dal sistema',
    'echo    3. PC lento: chiudi e riapri il launcher',
    'echo  Procedo comunque (alcune funzioni MCP potrebbero non funzionare).',
    'echo.',
    ':CDP_OK',
    'if "%CDP_READY%"=="1" echo  [OK] Browser connesso su porta 9222',
    '',
    ':: ── Avvia Claude Code in nuova finestra con PATH completo ─────────',
    // Usa un file helper temporaneo per evitare problemi di quoting in cmd /k
    'echo  [2/2] Avvio Claude Code...',
    'set "TV2C_HELPER=%TEMP%\\tv2c_run.bat"',
    `(`,
    `  echo @echo off`,
    `  echo set "PATH=%TV2C_PATH%;%PATH%"`,
    `  echo cd /d "${mcpDir}"`,
    `  echo "%CLAUDE_EXE%"`,
    `) > "%TV2C_HELPER%"`,
    'start "Claude Code" cmd /k "%TV2C_HELPER%"',
    'timeout /t 3 /nobreak >nul',
    'endlocal',
  ];

  const launcherPath = path.join(desktop, 'Avvia TradingView2Claude.bat');
  fs.writeFileSync(launcherPath, lines.join('\r\n'), { encoding: 'utf8' });
  sendLog('Launcher creato sul Desktop');
}

// ── IPC: INSTALLAZIONE ────────────────────────────────────────
ipcMain.on('start-install', async () => {
  let claudePath  = null;
  let mcpDir      = null;
  let browserPath = null;

  const steps = [
    { fn: step0_sistema     },
    { fn: step1_nodejs      },
    { fn: step2_git         },
    { fn: step3_claude      },  // → claudePath
    { fn: step4_mcp         },  // → mcpDir
    { fn: step5_findbrowser },  // → browserPath
  ];

  try {
    for (let i = 0; i < steps.length; i++) {
      sendStep(i, 'running');
      sendProgress(Math.round((i / 8) * 100));
      const result = await steps[i].fn();
      if (i === 3) claudePath  = result;
      if (i === 4) mcpDir      = result;
      if (i === 5) browserPath = result;
      sendStep(i, 'done');
    }

    sendStep(6, 'running');
    sendProgress(88);
    await step6_mcp(claudePath, mcpDir);
    sendStep(6, 'done');

    sendStep(7, 'running');
    sendProgress(95);
    await step7_launcher(claudePath, browserPath, mcpDir);
    sendStep(7, 'done');

    sendProgress(100);
    sendDone(true);

  } catch (err) {
    sendLog('');
    sendLog('══ ERRORE: ' + err.message);
    sendDone(false, err.message);
  }
});

// ── IPC: UI COMMANDS ─────────────────────────────────────────
ipcMain.on('close-app', () => app.quit());

ipcMain.on('open-launcher', () => {
  const launcherPath = path.join(HOME, 'Desktop', 'Avvia TradingView2Claude.bat');
  if (fs.existsSync(launcherPath)) {
    // Apre il .bat in una finestra cmd visibile (non con shell.openPath che potrebbe non aprire la console)
    spawn('cmd', ['/c', 'start', '', `"${launcherPath}"`], { shell: true, detached: true });
  } else {
    sendLog('Launcher non trovato sul Desktop — reinstalla');
  }
});

ipcMain.on('get-version', event => {
  event.sender.send('version', APP_VERSION);
});

// ── IPC: LICENZA ─────────────────────────────────────────────
ipcMain.on('check-license', async event => {
  const saved = loadLicense();
  if (!saved?.key) {
    event.sender.send('screen', { name: 'license' });
    return;
  }
  try {
    const res = await apiPost({ action: 'check', license_key: saved.key, machine_id: getMachineId() });
    if (res?.ok) {
      event.sender.send('screen', { name: 'install', data: { name: res.customer_name } });
    } else {
      clearLicense();
      event.sender.send('screen', { name: 'license' });
    }
  } catch (_) {
    // Errore di rete: mostra licenza per sicurezza
    event.sender.send('screen', { name: 'license' });
  }
});

ipcMain.on('activate', async (event, { key }) => {
  try {
    const res = await apiPost({
      action:       'activate',
      license_key:  key,
      machine_id:   getMachineId(),
      machine_info: `${os.platform()} ${os.arch()} ${os.hostname()}`,
    });
    if (res?.ok) {
      saveLicense({ key });
      event.sender.send('lic-result', { ok: true, customer_name: res.customer_name || 'Cliente' });
    } else {
      event.sender.send('lic-result', { ok: false, error: res?.error || 'Chiave non valida' });
    }
  } catch (e) {
    event.sender.send('lic-result', { ok: false, error: `Connessione fallita: ${e.message}` });
  }
});

// ── APP LIFECYCLE ─────────────────────────────────────────────
app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

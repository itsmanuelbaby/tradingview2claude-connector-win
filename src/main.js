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
    // shell:false su Mac (gestisce spazi nei path), shell:true su Windows (richiesto da winget/cmd)
    const proc = spawn(cmd, args, {
      shell: process.platform === 'win32',
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
    // Cerca con which in PATH esteso
    const extPath = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:' + (process.env.PATH || '');
    const w = await runQ('which claude', { env: { PATH: extPath } });
    if (w && w.trim() && fs.existsSync(w.trim())) return w.trim();

    // Tutti i percorsi possibili dove npm può installare claude su Mac
    const macPaths = [
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
      `${HOME}/.npm-global/bin/claude`,
      `${HOME}/Library/npm/bin/claude`,
      `${HOME}/.npm/bin/claude`,
      '/usr/local/lib/node_modules/.bin/claude',
      '/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude',
    ];

    // Cerca anche nel prefix npm del node bundled
    try {
      const bundledNode = getBundledNode();
      const bundledDir = path.dirname(bundledNode);
      const npmCli = path.join(bundledDir, 'npm_modules', 'bin', 'npm-cli.js');
      if (fs.existsSync(npmCli)) {
        const { execFileSync } = require('child_process');
        const prefix = execFileSync(bundledNode, [npmCli, 'config', 'get', 'prefix'], {
          env: { ...process.env, PATH: bundledDir + ':/usr/local/bin:/usr/bin:/bin' }
        }).toString().trim();
        if (prefix && prefix !== 'undefined') {
          macPaths.push(path.join(prefix, 'bin', 'claude'));
        }
      }
    } catch(_) {}

    for (const p of macPaths) if (p && fs.existsSync(p)) return p;
    return null;
  }

  // Windows: controlla prefix npm prima (più preciso)
  const prefix = await runQ('npm config get prefix');
  const prefixPaths = prefix && prefix !== 'undefined'
    ? [`${prefix}\\claude.cmd`] : [];

  const winPaths = [
    ...prefixPaths,
    process.env.APPDATA       ? `${process.env.APPDATA}\npm\claude.cmd`              : null,
    process.env.APPDATA       ? `${process.env.APPDATA}\npm\claude`                  : null,
    process.env.LOCALAPPDATA  ? `${process.env.LOCALAPPDATA}\npm\claude.cmd`         : null,
    process.env.LOCALAPPDATA  ? `${process.env.LOCALAPPDATA}\npm\claude`             : null,
    process.env.ProgramFiles  ? `${process.env.ProgramFiles}\nodejs\claude.cmd`      : null,
    process.env.ProgramFiles  ? `${process.env.ProgramFiles}\nodejs\npm\claude.cmd` : null,
  ].filter(Boolean);

  for (const p of winPaths) if (fs.existsSync(p)) return p;
  return null;
}

// ── TROVA TRADINGVIEW ────────────────────────────────────────
async function findTradingView() {
  if (IS_WIN) {
    // PRIORITA' 1: TradingView Desktop EXE
    const tvPaths = [
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'TradingView', 'TradingView.exe') : null,
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'TradingView', 'TradingView.exe') : null,
      process.env.APPDATA      ? path.join(process.env.APPDATA, 'TradingView', 'TradingView.exe') : null,
      process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'TradingView', 'TradingView.exe') : null,
      process.env.USERPROFILE  ? path.join(process.env.USERPROFILE, 'AppData', 'Local', 'Programs', 'TradingView', 'TradingView.exe') : null,
    ].filter(Boolean);
    for (const p of tvPaths) {
      if (p && fs.existsSync(p)) return { type: 'desktop', path: p };
    }
    for (const hive of ['HKCU', 'HKLM']) {
      try {
        const out = await runQ(`reg query "${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall" /s /f "TradingView" 2>nul`);
        if (out) {
          for (const line of out.split('\n')) {
            if (line.includes('InstallLocation')) {
              const val = line.split('REG_SZ').pop().trim();
              if (val) { const exe = path.join(val, 'TradingView.exe'); if (fs.existsSync(exe)) return { type: 'desktop', path: exe }; }
            }
          }
        }
      } catch(_) {}
    }

    // PRIORITA' 2: Chrome o Edge (fallback MSIX/Store)
    sendLog('TradingView Desktop non trovato — uso browser con tradingview.com');
    const browserCandidates = [
      process.env.ProgramFiles         ? path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
      process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
      process.env.LOCALAPPDATA         ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
      process.env.ProgramFiles         ? path.join(process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : null,
      process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe') : null,
      process.env.LOCALAPPDATA         ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : null,
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ].filter(Boolean);
    for (const p of browserCandidates) {
      if (p && fs.existsSync(p)) return { type: 'browser', path: p };
    }
    return null;
  }

  // Mac
  const macPaths = ['/Applications/TradingView.app', `${HOME}/Applications/TradingView.app`];
  for (const p of macPaths) if (fs.existsSync(p)) return p;
  return null;
}

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

  // Windows: verifica o installa Node.js
  const v = await runQ('node --version');
  if (v) { sendLog(`Node.js ${v} già installato`); return; }

  // METODO 1: winget con --source winget (forza origine winget, evita msstore)
  sendLog('Installazione Node.js LTS via winget...');
  await run('winget', [
    'install', '--id', 'OpenJS.NodeJS.LTS',
    '--source', 'winget',
    '--silent', '--accept-package-agreements', '--accept-source-agreements',
  ], { ignoreError: true });
  await refreshWinPath();

  let v2 = await runQ('node --version');
  if (v2) { sendLog(`Node.js ${v2} installato (winget)`); return; }

  // METODO 2: download diretto MSI da nodejs.org (universale, funziona sempre)
  sendLog('winget fallito, scarico Node.js da nodejs.org...');
  try {
    const tmpDir = process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp';
    const msiPath = path.join(tmpDir, 'nodejs-lts.msi');

    // URL ufficiale Node.js LTS — versione 22.x x64 stabile
    const nodeUrl = 'https://nodejs.org/dist/v22.11.0/node-v22.11.0-x64.msi';

    sendLog('Download in corso (circa 30 MB)...');
    await run('powershell', [
      '-nologo', '-noprofile', '-command',
      `Invoke-WebRequest -Uri '${nodeUrl}' -OutFile '${msiPath}' -UseBasicParsing`
    ], { ignoreError: false });

    if (!fs.existsSync(msiPath)) {
      throw new Error('Download MSI fallito');
    }

    sendLog('Installazione MSI in corso...');
    await run('msiexec', [
      '/i', msiPath,
      '/quiet', '/norestart',
      'ADDLOCAL=ALL'
    ], { ignoreError: false });

    await refreshWinPath();

    // Aggiorna PATH manualmente con i percorsi standard MSI
    const nodeStdPaths = [
      `${process.env.ProgramFiles}\\nodejs`,
      `${process.env['ProgramFiles(x86)']}\\nodejs`,
    ].filter(p => p && fs.existsSync(p));

    if (nodeStdPaths.length) {
      process.env.PATH = nodeStdPaths.join(';') + ';' + (process.env.PATH || '');
    }

    v2 = await runQ('node --version');
    if (!v2) {
      // Prova path assoluto diretto
      for (const p of nodeStdPaths) {
        const exe = path.join(p, 'node.exe');
        if (fs.existsSync(exe)) {
          v2 = await runQ(`"${exe}" --version`);
          if (v2) {
            sendLog(`Node.js ${v2} installato (MSI diretto)`);
            return;
          }
        }
      }
    } else {
      sendLog(`Node.js ${v2} installato (MSI diretto)`);
      return;
    }
  } catch (e) {
    sendLog(`Download MSI fallito: ${e.message}`);
  }

  // METODO 3: ZIP standalone (non richiede msiexec, niente permessi Admin)
  sendLog('MSI fallito — provo ZIP portable di Node.js...');
  try {
    const tmpDir = process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp';
    const zipPath = path.join(tmpDir, 'node-portable.zip');
    const installDir = path.join(process.env.LOCALAPPDATA || tmpDir, 'PortableNode');
    const zipUrl = 'https://nodejs.org/dist/v22.11.0/node-v22.11.0-win-x64.zip';

    sendLog('Download Node.js portable (~30 MB)...');
    await run('powershell', [
      '-nologo', '-noprofile', '-command',
      `Invoke-WebRequest -Uri '${zipUrl}' -OutFile '${zipPath}' -UseBasicParsing`
    ], { ignoreError: false });

    if (fs.existsSync(zipPath)) {
      sendLog('Estrazione Node.js portable...');
      await run('powershell', [
        '-nologo', '-noprofile', '-command',
        `Expand-Archive -Path '${zipPath}' -DestinationPath '${installDir}' -Force`
      ], { ignoreError: false });

      // Trova node.exe nella sottocartella estratta
      const portableNodeDir = path.join(installDir, 'node-v22.11.0-win-x64');
      const portableNode = path.join(portableNodeDir, 'node.exe');
      if (fs.existsSync(portableNode)) {
        process.env.PATH = portableNodeDir + ';' + (process.env.PATH || '');
        const v3 = await runQ(`"${portableNode}" --version`);
        if (v3) { sendLog(`Node.js ${v3} installato (portable)`); return; }
      }
    }
  } catch (e) {
    sendLog(`ZIP portable fallito: ${e.message}`);
  }

  throw new Error(
    'Impossibile installare Node.js automaticamente.\n' +
    'Connessione internet o policy aziendale potrebbero bloccare i download.\n' +
    'Scaricalo manualmente da: https://nodejs.org/\n' +
    'Poi riesegui l\'installer.'
  );
}

// Step 2 — Git (solo Windows, su Mac non serve più)
async function step2_git() {
  if (IS_MAC) {
    sendLog('Git non necessario su Mac — OK');
    return;
  }

  // Windows: 3 metodi a cascata
  const v = await runQ('git --version');
  if (v) { sendLog(`Git già installato`); return; }

  // METODO 1: winget --source winget (evita errori msstore)
  sendLog('Installazione Git via winget...');
  await run('winget', [
    'install', '--id', 'Git.Git',
    '--source', 'winget',
    '--silent', '--accept-package-agreements', '--accept-source-agreements',
  ], { ignoreError: true });
  await refreshWinPath();
  let v2 = await runQ('git --version');
  if (v2) { sendLog('Git installato (winget)'); return; }

  // METODO 2: Git Portable da GitHub (zip standalone, funziona sempre)
  sendLog('winget fallito — scarico Git Portable da GitHub...');
  try {
    const tmpDir = process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp';
    const zipPath = path.join(tmpDir, 'PortableGit.7z.exe');
    const installDir = path.join(process.env.LOCALAPPDATA || tmpDir, 'PortableGit');
    // Git for Windows portable self-extracting
    const gitUrl = 'https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.1/PortableGit-2.47.1-64-bit.7z.exe';

    sendLog('Download Git Portable (~50 MB)...');
    await run('powershell', [
      '-nologo', '-noprofile', '-command',
      `Invoke-WebRequest -Uri '${gitUrl}' -OutFile '${zipPath}' -UseBasicParsing`
    ], { ignoreError: false });

    if (fs.existsSync(zipPath)) {
      sendLog('Estrazione Git Portable...');
      // Self-extracting 7z: -o<path> -y
      await run(zipPath, [`-o${installDir}`, '-y'], { ignoreError: false });
      const portableGit = path.join(installDir, 'cmd', 'git.exe');
      if (fs.existsSync(portableGit)) {
        // Aggiungi al PATH della sessione corrente
        const gitDir = path.join(installDir, 'cmd');
        process.env.PATH = gitDir + ';' + (process.env.PATH || '');
        v2 = await runQ('git --version');
        if (v2) { sendLog('Git installato (portable)'); return; }
      }
    }
  } catch (e) {
    sendLog(`Git portable fallito: ${e.message}`);
  }

  throw new Error(
    'Impossibile installare Git automaticamente.\n' +
    'Scaricalo manualmente da: https://git-scm.com/\n' +
    'Poi riesegui l\'installer.'
  );
}

// Step 3 — Claude Code
async function step3_claude() {
  let claudePath = await findClaude();
  if (claudePath) { sendLog('Claude Code già installato'); return claudePath; }

  sendLog('Installazione Claude Code in corso...');

  if (IS_MAC) {
    const bundledNode = getBundledNode();
    const bundledDir  = path.dirname(bundledNode);
    fs.chmodSync(bundledNode, 0o755);

    // npm-cli.js bundled nell'app (viene dalla cartella npm_modules inclusa nella build)
    const npmCli = path.join(bundledDir, 'npm_modules', 'bin', 'npm-cli.js');

    if (!fs.existsSync(npmCli)) {
      throw new Error(
        'npm bundled non trovato: ' + npmCli + '\n' +
        'Reinstalla il software.'
      );
    }

    // Crea symlink node se non esiste
    const nodeSymlink = path.join(bundledDir, 'node');
    if (!fs.existsSync(nodeSymlink)) {
      try { fs.symlinkSync(bundledNode, nodeSymlink); } catch(_) {}
    }

    const cleanEnv = {
      ...process.env,
      PATH: bundledDir + ':/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'
    };

    // Usa node bundled per eseguire npm-cli.js bundled — zero dipendenze esterne
    await run(bundledNode, [npmCli, 'install', '-g', '@anthropic-ai/claude-code'], {
      cwd: HOME,
      env: cleanEnv
    });

  } else {
    // Windows: cerca npm in tutti i path standard
    const winNpmCandidates = [
      process.env.ProgramFiles  ? `${process.env.ProgramFiles}\nodejs\npm.cmd`  : null,
      process.env.APPDATA       ? `${process.env.APPDATA}\npm\npm.cmd`           : null,
      process.env.LOCALAPPDATA  ? `${process.env.LOCALAPPDATA}\npm\npm.cmd`      : null,
      'npm', // fallback generico
    ].filter(Boolean);

    let winNpm = 'npm';
    for (const p of winNpmCandidates) {
      if (p === 'npm') { winNpm = 'npm'; break; }
      if (fs.existsSync(p)) { winNpm = p; break; }
    }

    const winEnv = {
      ...process.env,
      PATH: [
        process.env.ProgramFiles  ? `${process.env.ProgramFiles}\nodejs`  : '',
        process.env.APPDATA       ? `${process.env.APPDATA}\npm`           : '',
        process.env.LOCALAPPDATA  ? `${process.env.LOCALAPPDATA}\npm`      : '',
        process.env.PATH || '',
      ].filter(Boolean).join(';')
    };

    await run(winNpm, ['install', '-g', '@anthropic-ai/claude-code'], {
      cwd: HOME,
      env: winEnv
    });
  }

  await refreshWinPath();
  await new Promise(r => setTimeout(r, 3000));
  claudePath = await findClaude();

  if (!claudePath) {
    // RETRY: aspetta più a lungo e cerca di nuovo (npm può essere lento)
    sendLog('Claude Code non subito disponibile — attendo PATH...');
    await new Promise(r => setTimeout(r, 5000));
    await refreshWinPath();
    claudePath = await findClaude();
  }

  if (!claudePath) {
    // SECONDO RETRY: cerca anche in path npm globali alternativi
    const altPaths = IS_WIN ? [
      process.env.APPDATA       ? `${process.env.APPDATA}\\npm\\claude.cmd`         : null,
      process.env.LOCALAPPDATA  ? `${process.env.LOCALAPPDATA}\\npm\\claude.cmd`    : null,
      process.env.ProgramFiles  ? `${process.env.ProgramFiles}\\nodejs\\claude.cmd` : null,
    ].filter(Boolean) : [];
    for (const p of altPaths) {
      if (fs.existsSync(p)) { claudePath = p; break; }
    }
  }

  if (!claudePath) {
    throw new Error(
      'Claude Code non trovato dopo installazione.\n' +
      'Possibili cause:\n' +
      '  1. npm install ha avuto problemi di rete\n' +
      '  2. Antivirus ha bloccato l\'installazione globale\n' +
      '  3. Permessi mancanti su cartella npm globale\n' +
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
      await run('cp', ['-r', bundledMcp + '/.', dest], { ignoreError: false });
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
  if (IS_WIN) {
    sendLog('Ricerca TradingView Desktop o browser...');
    const result = await findTradingView();
    if (!result) sendLog('ATTENZIONE: nessuna installazione trovata');
    else if (result.type === 'desktop') sendLog(`TradingView Desktop: ${result.path}`);
    else sendLog(`Modalita web browser: ${result.path}`);
    return result;
  }
  sendLog('Ricerca TradingView...');
  const p = await findTradingView();
  if (p) sendLog(`TradingView trovato: ${p}`);
  else sendLog('TradingView non trovato');
  return p;
}

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

  // Rimuovi eventuali registrazioni precedenti (evita conflitti su reinstall)
  for (const oldName of ['tradingview', 'tradingview-mcp']) {
    await run(
      claudePath,
      ['mcp', 'remove', oldName],
      { cwd: HOME, ignoreError: true }
    );
  }

  // Registra il server MCP con nome 'tradingview-mcp' (universale, allineato al package.json)
  await run(
    claudePath,
    ['mcp', 'add', 'tradingview-mcp', '--', 'node', indexPath],
    { cwd: HOME, ignoreError: true }
  );

  // Verifica che la registrazione sia andata a buon fine
  try {
    const out = await runQ(`"${claudePath}" mcp list`, 10000);
    if (out && out.includes('tradingview-mcp')) {
      sendLog('Server MCP configurato correttamente');
    } else {
      sendLog('ATTENZIONE: registrazione MCP non confermata');
    }
  } catch (_) {
    sendLog('Server MCP configurato');
  }
}

// Step 7 — Crea launcher sul Desktop
async function step7_launcher(claudePath, tvPath, mcpDir) {
  if (!claudePath) throw new Error('Percorso Claude Code non determinato');

  const desktop = path.join(HOME, 'Desktop');
  if (!fs.existsSync(desktop)) {
    fs.mkdirSync(desktop, { recursive: true });
  }

  if (IS_WIN) {
    const claudeExe = `"${claudePath}"`;
    const tvType    = (tvPath && tvPath.type) ? tvPath.type : 'browser';
    const tvExePath = (tvPath && tvPath.path) ? tvPath.path : '';

    // Costruisci variabile PATH che useremo sia nel bat principale sia in cmd /k
    const PATH_LINE = 'set "TVCLAUDE_PATH=%ProgramFiles%\\nodejs;%LOCALAPPDATA%\\Programs\\nodejs;%APPDATA%\\npm;%LOCALAPPDATA%\\npm;%LOCALAPPDATA%\\PortableGit\\cmd;%ProgramFiles%\\Git\\cmd;%SystemRoot%\\System32;%SystemRoot%"';

    const lines = [
      '@echo off',
      'setlocal enabledelayedexpansion',
      'title TradingView2Claude Connector',
      'cls',
      '',
      ':: PATH completo (nodejs, npm, git portable, system) — usato anche da cmd /k',
      PATH_LINE,
      'set "PATH=%TVCLAUDE_PATH%;%PATH%"',
      '',
      'echo.',
      'echo  +==============================================+',
      'echo  ^|      TradingView2Claude Connector          ^|',
      'echo  +==============================================+',
      'echo.',
      '',
      ':: Trova node.exe con path assoluto',
      'set "NODE_EXE="',
      'if exist "%ProgramFiles%\\nodejs\\node.exe" set "NODE_EXE=%ProgramFiles%\\nodejs\\node.exe"',
      'if not defined NODE_EXE if exist "%LOCALAPPDATA%\\Programs\\nodejs\\node.exe" set "NODE_EXE=%LOCALAPPDATA%\\Programs\\nodejs\\node.exe"',
      'if not defined NODE_EXE if exist "%ProgramFiles(x86)%\\nodejs\\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\\nodejs\\node.exe"',
      'if not defined NODE_EXE set "NODE_EXE=node"',
      '',
      ':: Trova claude.cmd con path assoluto',
      'set "CLAUDE_EXE="',
      `if exist "${claudePath}" set "CLAUDE_EXE=${claudePath}"`,
      'if not defined CLAUDE_EXE for /f "delims=" %%c in (\'where claude 2^>nul\') do set "CLAUDE_EXE=%%c"',
      'if not defined CLAUDE_EXE (',
      '  echo  X Claude Code non trovato. Reinstalla il software.',
      '  pause',
      '  exit /b 1',
      ')',
      '',
      ':: ── REGISTRA MCP (idempotente) — ESPLICITAMENTE con verifica ─────────',
      'set "MCP_ENTRY="',
      `if exist "${mcpDir}\\src\\server.js" set "MCP_ENTRY=${mcpDir}\\src\\server.js"`,
      `if not defined MCP_ENTRY if exist "${mcpDir}\\src\\index.js" set "MCP_ENTRY=${mcpDir}\\src\\index.js"`,
      `if not defined MCP_ENTRY if exist "${mcpDir}\\index.js" set "MCP_ENTRY=${mcpDir}\\index.js"`,
      'if not defined MCP_ENTRY (',
      '  echo  X File MCP server non trovato. Reinstalla il software.',
      '  pause',
      '  exit /b 1',
      ')',
      'call "%CLAUDE_EXE%" mcp remove tradingview >nul 2>&1',
      'call "%CLAUDE_EXE%" mcp remove tradingview-mcp >nul 2>&1',
      'call "%CLAUDE_EXE%" mcp add tradingview-mcp -- "%NODE_EXE%" "%MCP_ENTRY%" >nul 2>&1',
      ':: Verifica registrazione',
      'set "MCP_OK=0"',
      'for /f "delims=" %%a in (\'"%CLAUDE_EXE%" mcp list 2^>nul ^| findstr "tradingview-mcp"\') do set "MCP_OK=1"',
      'if "%MCP_OK%"=="0" (',
      '  echo  ATTENZIONE: registrazione MCP non confermata',
      '  echo  Riprovo...',
      '  call "%CLAUDE_EXE%" mcp add tradingview-mcp -- "%NODE_EXE%" "%MCP_ENTRY%" >nul 2>&1',
      ')',
      '',
      ':: ── Chiudi sessioni precedenti ────────────────────────────────────────',
      'taskkill /f /im node.exe >nul 2>&1',
      '%SystemRoot%\\System32\\netstat.exe -ano | findstr ":9222 " >nul 2>&1 && (',
      '  for /f "tokens=5" %%p in (\'%SystemRoot%\\System32\\netstat.exe -ano ^| findstr ":9222 "\') do taskkill /f /pid %%p >nul 2>&1',
      '  timeout /t 2 /nobreak >nul',
      ')',
      '',
      ...(tvType === 'desktop' ? [
        ':: ── Modalita Desktop: TradingView.exe con CDP (supporta disegni) ───',
        'echo  [1/2] Apertura TradingView Desktop...',
        `set "TV_EXE=${tvExePath}"`,
        'if not defined TV_EXE if exist "%LOCALAPPDATA%\\Programs\\TradingView\\TradingView.exe" set "TV_EXE=%LOCALAPPDATA%\\Programs\\TradingView\\TradingView.exe"',
        'if not defined TV_EXE (',
        '  echo  X TradingView Desktop non trovato.',
        '  echo    Installa TradingView dal sito: https://www.tradingview.com/desktop/',
        '  pause',
        '  exit /b 1',
        ')',
        'taskkill /f /im TradingView.exe >nul 2>&1',
        'timeout /t 2 /nobreak >nul',
        ':: schtasks: lancia come utente normale (fix permessi Admin)',
        'schtasks /create /tn "TV2C_Launch" /tr "\\"%TV_EXE%\\" --remote-debugging-port=9222" /sc once /st 00:00 /ru "%USERNAME%" /rl LIMITED /f >nul 2>&1',
        'set "SCHTASKS_OK=%errorlevel%"',
        'schtasks /run /tn "TV2C_Launch" >nul 2>&1',
        'schtasks /delete /tn "TV2C_Launch" /f >nul 2>&1',
        ':: Fallback se schtasks fallisce (PC con Task Scheduler disattivato)',
        'if not "%SCHTASKS_OK%"=="0" (',
        '  start "" explorer.exe "%TV_EXE%"',
        '  timeout /t 3 /nobreak >nul',
        ')',
        'echo  Attendo TradingView Desktop...',
      ] : [
        ':: ── Modalita Web: Chrome/Edge con tradingview.com ─────────────────',
        'echo  [1/2] Apertura TradingView nel browser...',
        'set "BROWSER_EXE="',
        ...(tvExePath ? [`if exist "${tvExePath}" set "BROWSER_EXE=${tvExePath}"`] : []),
        'if not defined BROWSER_EXE if exist "%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe" set "BROWSER_EXE=%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe"',
        'if not defined BROWSER_EXE if exist "%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe" set "BROWSER_EXE=%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe"',
        'if not defined BROWSER_EXE if exist "%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe" set "BROWSER_EXE=%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe"',
        'if not defined BROWSER_EXE if exist "%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe" set "BROWSER_EXE=%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe"',
        'if not defined BROWSER_EXE if exist "%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe" set "BROWSER_EXE=%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe"',
        'if not defined BROWSER_EXE if exist "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe" set "BROWSER_EXE=C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"',
        'if not defined BROWSER_EXE (',
        '  echo  X Nessun browser trovato.',
        '  echo    Installa Google Chrome: https://www.google.com/chrome/',
        '  pause',
        '  exit /b 1',
        ')',
        'set "CDP_PROFILE=%USERPROFILE%\\tv2claude-browser-profile"',
        'if not exist "%CDP_PROFILE%" mkdir "%CDP_PROFILE%"',
        'start "" "%BROWSER_EXE%" --remote-debugging-port=9222 --user-data-dir="%CDP_PROFILE%" --app=https://www.tradingview.com --window-size=1400,900 --no-first-run --no-default-browser-check',
        'echo  Attendo browser...',
      ]),
      ':: ── Attesa CDP (max 40 sec) ──────────────────────────────────────────',
      'set CDP_READY=0',
      'set RETRY=0',
      ':WAIT_CDP',
      'timeout /t 2 /nobreak >nul',
      '%SystemRoot%\\System32\\curl.exe -s http://localhost:9222/json/version >nul 2>&1 && set CDP_READY=1',
      'if "%CDP_READY%"=="1" goto CDP_OK',
      'set /a RETRY+=1',
      'if %RETRY% lss 20 goto WAIT_CDP',
      'echo.',
      'echo  ATTENZIONE: TradingView non risponde sulla porta 9222.',
      'echo  Possibili cause:',
      'echo    1. Antivirus o firewall sta bloccando la porta locale 9222',
      'echo    2. TradingView e bloccato dal sistema',
      'echo    3. PC molto lento - aspetta ancora 20 secondi e riprova',
      'echo  Procedo comunque, ma Claude potrebbe non vedere i grafici.',
      'echo.',
      ':CDP_OK',
      'if "%CDP_READY%"=="1" echo  [OK] Connesso su porta 9222',
      '',
      ':: ── Avvio Claude Code in nuova finestra con PATH ESPLICITO ──────────',
      'echo  [2/2] Avvio Claude Code...',
      ':: cmd /k apre nuova finestra. PATH viene passato esplicitamente per evitare problemi.',
      ':: Path con spazi nel nome utente: usiamo virgolette interne con escape ^"',
      `start "Claude Code" cmd /k "set PATH=%TVCLAUDE_PATH%;%PATH%&& cd /d \"${mcpDir}\" && \"${claudePath}\""`,
      'timeout /t 3 /nobreak >nul',
      'endlocal',
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

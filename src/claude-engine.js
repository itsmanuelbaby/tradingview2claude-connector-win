'use strict';

// ================================================================
//  claude-engine.js — pilota Claude Code in modalità headless
//  Spawna il binario `claude` con --output-format stream-json,
//  intercetta lo streaming e lo inoltra alla UI tramite callback.
//  Il cliente usa il SUO abbonamento (nessuna chiave API).
// ================================================================

const { spawn, execSync } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const memory = require('./memory');

const HOME = os.homedir();
const IS_WIN = process.platform === 'win32';
// Log dir cross-platform: Windows → %LOCALAPPDATA%, macOS → ~/Library/Logs
const LOG_DIR = IS_WIN
  ? path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'),
              'TradingView2Claude', 'Logs')
  : path.join(HOME, 'Library', 'Logs', 'TradingView2Claude');
const LOG_FILE = path.join(LOG_DIR, 'chat.log');
function personaFileFor(lang) {
  const fname = lang === 'en' ? 'persona-en.txt' : 'persona.txt';
  return path.join(__dirname, fname);
}

// Timeout di sicurezza per una singola risposta (analisi con più tool = lente)
const TURN_TIMEOUT_MS = 180000;

// ── Stato conversazione (una sessione per avvio app) ─────────────
let sessionId = null;

// Modello AI in uso (opus = massima qualità, default)
let currentModel = 'opus';
function setModel(m) {
  if (m === 'opus' || m === 'sonnet' || m === 'haiku') {
    currentModel = m;
    log(`Modello impostato: ${m}`);
  }
}

// Lingua dell'assistente (it default)
let currentLang = 'it';
function setLang(l) {
  if (l === 'it' || l === 'en') {
    currentLang = l;
    log(`Lingua impostata: ${l}`);
  }
}

// Directory per file temporanei (prompt/persona).
// Default: os.tmpdir() (rispetta TEMP env var, OneDrive-aware su Win).
// main.js può sovrascriverlo con app.getPath('userData') per usare un path
// dedicato all'app — più stabile, non viene mai pulito.
let TEMP_DIR = os.tmpdir();
function setTempDir(p) {
  if (p && typeof p === 'string') {
    try { fs.mkdirSync(p, { recursive: true }); } catch (_) {}
    TEMP_DIR = p;
  }
}

// ── Log diagnostico ──────────────────────────────────────────────
function log(msg) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (_) {}
}

// ── Trova il binario `claude` (universale, cross-platform) ───────
function findClaudeBinary() {
  if (IS_WIN) {
    // Tutti i path dove gli installer noti mettono il binario:
    // - Installer ufficiale Anthropic (irm install.ps1): .claude\local o .claude\bin
    // - install via npm globale: %APPDATA%\npm o %LOCALAPPDATA%\npm
    // - MSI / Program Files
    const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
    const LOCAL   = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
    const PF      = process.env.ProgramFiles || 'C:\\Program Files';
    const PFx86   = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const candidates = [
      path.join(HOME, '.claude', 'local', 'claude.exe'),
      path.join(HOME, '.claude', 'bin', 'claude.exe'),
      path.join(HOME, '.claude', 'claude.exe'),
      path.join(HOME, '.local', 'bin', 'claude.exe'),
      path.join(HOME, '.local', 'bin', 'claude.cmd'),
      path.join(HOME, '.local', 'bin', 'claude'),
      path.join(APPDATA, 'npm', 'claude.cmd'),
      path.join(APPDATA, 'npm', 'claude.exe'),
      path.join(LOCAL,   'npm', 'claude.cmd'),
      path.join(LOCAL, 'Programs', 'Claude', 'claude.exe'),
      path.join(LOCAL, 'Programs', 'claude', 'claude.exe'),
      path.join(LOCAL, 'Anthropic', 'Claude', 'claude.exe'),
      path.join(PF, 'Anthropic', 'Claude', 'claude.exe'),
      path.join(PFx86, 'Anthropic', 'Claude', 'claude.exe'),
      path.join(PF, 'nodejs', 'claude.cmd'),
    ];
    for (const c of candidates) {
      try { if (fs.existsSync(c)) return c; } catch (_) {}
    }
    // Fallback 1: where claude (cmd builtin)
    try {
      const w = execSync('where claude', { encoding: 'utf8' }).trim();
      if (w) {
        const first = w.split(/\r?\n/)[0].trim();
        if (first && fs.existsSync(first)) return first;
      }
    } catch (_) {}
    // Fallback 2: Get-Command (PowerShell, più affidabile per .cmd/.ps1)
    try {
      const gc = execSync(
        'powershell -NoProfile -ExecutionPolicy Bypass -Command "(Get-Command claude -ErrorAction SilentlyContinue).Source"',
        { encoding: 'utf8', timeout: 8000 }
      ).trim();
      if (gc && fs.existsSync(gc)) return gc;
    } catch (_) {}
    return null;
  }
  // ── macOS / Linux ──
  const candidates = [
    path.join(HOME, '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(HOME, '.npm-global', 'bin', 'claude'),
    path.join(HOME, 'Library', 'Application Support', 'npm', 'bin', 'claude'),
    '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude',
    '/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude',
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  try {
    const w = execSync('which claude', { encoding: 'utf8' }).trim();
    if (w && fs.existsSync(w)) return w;
  } catch (_) {}
  const ccDir = path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude-code');
  try {
    if (fs.existsSync(ccDir)) {
      const found = execSync(
        `find "${ccDir}" -path "*/MacOS/claude" -type f 2>/dev/null | sort -V | tail -1`,
        { encoding: 'utf8' }
      ).trim();
      if (found && fs.existsSync(found)) return found;
    }
  } catch (_) {}
  return null;
}

// ── PATH robusto: claude ha bisogno di node nel PATH ─────────────
function buildEnv() {
  let extra;
  if (IS_WIN) {
    const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
    const LOCAL   = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
    const PF      = process.env.ProgramFiles || 'C:\\Program Files';
    const PFx86   = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    extra = [
      path.join(HOME, '.local', 'bin'),
      path.join(APPDATA, 'npm'),
      path.join(LOCAL, 'npm'),
      path.join(PF, 'nodejs'),
      path.join(PFx86, 'nodejs'),
      path.join(LOCAL, 'Programs', 'nodejs'),
    ];
  } else {
    extra = [
      '/opt/homebrew/bin',
      '/usr/local/bin',
      path.join(HOME, '.local', 'bin'),
      '/usr/bin', '/bin',
    ];
  }
  const sep = IS_WIN ? ';' : ':';
  const current = process.env.PATH || '';
  return Object.assign({}, process.env, {
    PATH: extra.join(sep) + (current ? sep + current : ''),
  });
}

// ── Etichette amichevoli per gli strumenti TradingView ───────────
function friendlyTool(name) {
  if (!name) return 'Sto consultando TradingView…';
  const n = String(name).replace('mcp__tradingview-mcp__', '');
  if (/screenshot|capture/.test(n))               return 'Sto osservando il grafico…';
  if (/^chart_set|set_symbol|set_timeframe|scroll/.test(n)) return 'Sto aggiornando il grafico…';
  if (/^chart_get|get_state|visible_range/.test(n)) return 'Sto leggendo il grafico…';
  if (/quote|symbol_info|^depth/.test(n))         return 'Sto controllando le quotazioni…';
  if (/^data_get/.test(n))                        return 'Sto analizzando i dati…';
  if (/indicator|study/.test(n))                  return 'Sto leggendo gli indicatori…';
  if (/symbol_search|watchlist/.test(n))          return 'Sto cercando il simbolo…';
  if (/draw/.test(n))                             return 'Sto disegnando sul grafico…';
  if (/alert/.test(n))                            return 'Sto gestendo gli alert…';
  if (/pine/.test(n))                             return 'Sto lavorando sullo script…';
  if (/replay/.test(n))                           return 'Sto usando la modalità replay…';
  return 'Sto consultando TradingView…';
}

// ── Rimuove dal testo le righe [LEZIONE] e [PREVISIONE] ──────────
// (vengono salvate nel vault, non mostrate in chat)
function stripLessons(text) {
  return String(text || '').replace(/^[ \t]*\[(LEZIONE|PREVISIONE)\][^\n]*\n?/gim, '');
}

// ── Interpreta una riga NDJSON dello stream ──────────────────────
function handleLine(line, state, handlers) {
  let msg;
  try { msg = JSON.parse(line); } catch (_) { return; }

  // init di sessione → cattura session_id
  if (msg.type === 'system' && msg.subtype === 'init') {
    if (msg.session_id) sessionId = msg.session_id;
    return;
  }

  // messaggi dell'assistente: testo + chiamate strumenti
  if (msg.type === 'assistant' && msg.message && Array.isArray(msg.message.content)) {
    for (const block of msg.message.content) {
      if (block.type === 'text' && block.text) {
        state.gotText = true;
        state.rawAnswer += block.text;
        const shown = stripLessons(block.text);
        if (shown.trim()) handlers.onText(shown);
      } else if (block.type === 'tool_use') {
        handlers.onTool(friendlyTool(block.name));
      }
    }
    return;
  }

  // risultato finale
  if (msg.type === 'result') {
    if (msg.session_id) sessionId = msg.session_id;
    if (msg.is_error && !state.gotText) {
      const txt = (typeof msg.result === 'string' && msg.result) ? msg.result : '';
      state.resultError = txt || 'Errore durante l\'elaborazione.';
    } else if (!msg.is_error && !state.gotText &&
               typeof msg.result === 'string' && msg.result.trim()) {
      // Sicurezza: nessun testo nei messaggi 'assistant' → usa il risultato finale
      state.gotText = true;
      state.rawAnswer += msg.result;
      const shown = stripLessons(msg.result);
      if (shown.trim()) handlers.onText(shown);
    }
    return;
  }
}

// ── Chiede una risposta a Claude ─────────────────────────────────
// handlers: { onText(str), onTool(label), onError(msg), onDone() }
function ask(userMessage, handlers) {
  const claude = findClaudeBinary();
  if (!claude) {
    log('ERRORE: binario claude non trovato');
    handlers.onError('Claude non è stato trovato. Apri l\'app per completare la configurazione iniziale.');
    return;
  }

  // Reinietta la memoria: lezioni apprese + analisi passate rilevanti
  let prompt = userMessage;
  try {
    const ctx = memory.buildContext(userMessage, currentLang);
    if (ctx) {
      const heading = currentLang === 'en' ? '# CURRENT USER QUESTION' : '# DOMANDA ATTUALE';
      prompt = ctx + '\n\n' + heading + '\n' + userMessage;
    }
  } catch (e) { log('memory context error: ' + e.message); }

  // Persona personalizzata
  let persona = '';
  try {
    let pf = personaFileFor(currentLang);
    if (!fs.existsSync(pf)) pf = personaFileFor('it'); // fallback
    if (fs.existsSync(pf)) persona = fs.readFileSync(pf, 'utf8');
  } catch (_) {}

  log(`SPAWN ${claude} (sessione: ${sessionId || 'nuova'}, piattaforma: ${process.platform})`);

  let child;
  try {
    if (IS_WIN) {
      // ── WINDOWS ──────────────────────────────────────────────────
      // Strategy: spawn DIRETTO senza shell di mezzo. Node CreateProcess
      // passa args raw (escape automatico di " interne, multiline preservato).
      // - claude.exe: spawn diretto del binario nativo
      // - claude.cmd: claude.cmd è solo `node cli.js %*` → estraiamo i path
      //   e spawniamo node.exe direttamente. Eliminiamo cmd.exe/PowerShell:
      //   entrambi possono bufferizzare/alterare lo stream NDJSON.
      const args = [
        '-p', prompt,
        '--output-format', 'stream-json',
        '--verbose',
        '--model', currentModel,
        '--allowedTools', 'mcp__tradingview-mcp__*,WebSearch',
      ];
      if (sessionId) args.push('--resume', sessionId);
      if (persona.trim()) args.push('--append-system-prompt', persona);

      let execTarget = claude;
      let execArgs = args;

      if (/\.cmd$/i.test(claude)) {
        // Parse claude.cmd per estrarre node.exe + cli.js. Template tipico:
        //   @"C:\Program Files\nodejs\node.exe"  "C:\...\node_modules\...\cli.js" %*
        try {
          const cmdContent = fs.readFileSync(claude, 'utf8');
          // Match: due path quotati separati da spazi (node.exe e qualcosa.js)
          const m = cmdContent.match(/"([^"]+(?:node\.exe|node))"\s+"([^"]+\.(?:js|mjs|cjs))"/i);
          if (m) {
            execTarget = m[1];
            execArgs = [m[2], ...args];
            log(`Estratto da .cmd: node=${execTarget}  cli=${m[2]}`);
          } else {
            // Fallback: se non riusciamo a parsare, usiamo cmd /c
            // (con shell:false per evitare doppio quoting)
            log('WARNING: claude.cmd non parsabile, uso cmd /c fallback');
            execTarget = process.env.ComSpec || 'cmd.exe';
            execArgs = ['/c', claude, ...args];
          }
        } catch (e) {
          log(`Errore lettura claude.cmd: ${e.message}`);
          execTarget = process.env.ComSpec || 'cmd.exe';
          execArgs = ['/c', claude, ...args];
        }
      }
      // Se .exe: spawn diretto del binario, niente da fare

      log(`SPAWN exec: ${execTarget}`);
      child = spawn(execTarget, execArgs, {
        cwd: HOME,
        env: buildEnv(),
        shell: false,           // CRUCIALE: niente shell di mezzo
        windowsHide: true,
        // Forza encoding UTF-8 lato Node per non avere mojibake
        // sui dati italiani della persona
      });
    } else {
      // ── macOS / Linux ────────────────────────────────────────────
      // spawn diretto: niente shell di mezzo, args passati raw al processo.
      // Sicuro anche con prompt/persona multiline.
      const args = [
        '-p', prompt,
        '--output-format', 'stream-json',
        '--verbose',
        '--model', currentModel,
        '--allowedTools', 'mcp__tradingview-mcp__*,WebSearch',
      ];
      if (sessionId) args.push('--resume', sessionId);
      if (persona.trim()) args.push('--append-system-prompt', persona);

      child = spawn(claude, args, { cwd: HOME, env: buildEnv() });
    }
  } catch (e) {
    log(`ERRORE spawn: ${e.message}`);
    handlers.onError('Impossibile avviare il motore di analisi.');
    return;
  }

  const state = { gotText: false, resultError: null, finished: false, rawAnswer: '' };
  let stdoutBuf = '';
  let stderrBuf = '';

  const timer = setTimeout(() => {
    log('TIMEOUT — chiudo il processo');
    try {
      if (IS_WIN && child.pid) {
        // Su Windows con shell:true il PID è quello di cmd.exe; serve taskkill /T
        // per terminare anche il processo claude figlio.
        execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: 'ignore' });
      } else {
        child.kill('SIGTERM');
      }
    } catch (_) {}
  }, TURN_TIMEOUT_MS);

  function finish(errMsg) {
    if (state.finished) return;
    state.finished = true;
    clearTimeout(timer);
    if (errMsg) {
      handlers.onError(errMsg);
      return;
    }
    // Successo → salva l'analisi nel vault, estrai lezioni e previsioni
    if (state.rawAnswer.trim()) {
      try {
        memory.extractLessons(state.rawAnswer);
        memory.extractPredictions(state.rawAnswer);
        memory.saveNote(userMessage, stripLessons(state.rawAnswer).trim());
      } catch (e) { log('memory save error: ' + e.message); }
    }
    handlers.onDone();
  }

  // Conta byte totali stdout/stderr per debug "claude esce senza output"
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let firstChunkLogged = false;

  child.stdout.on('data', (d) => {
    stdoutBytes += d.length;
    if (!firstChunkLogged) {
      firstChunkLogged = true;
      // Logga i primi 200 byte raw per capire se l'output è NDJSON o altro
      log(`PRIMO CHUNK stdout (${d.length}b): ${d.toString('utf8').slice(0, 200).replace(/\n/g, '\\n')}`);
    }
    stdoutBuf += d.toString('utf8');
    let nl;
    while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (line) handleLine(line, state, handlers);
    }
  });

  child.stderr.on('data', (d) => {
    stderrBytes += d.length;
    stderrBuf += d.toString('utf8');
  });

  child.on('error', (e) => {
    log(`ERRORE processo: ${e.message}`);
    finish('Impossibile comunicare con il motore di analisi.');
  });

  child.on('close', (code) => {
    if (stdoutBuf.trim()) handleLine(stdoutBuf.trim(), state, handlers);
    log(`CHIUSO code=${code} gotText=${state.gotText} stdout=${stdoutBytes}b stderr=${stderrBytes}b`);
    if (stderrBuf.trim()) log(`STDERR: ${stderrBuf.trim().slice(0, 500)}`);

    if (state.resultError && !state.gotText) {
      finish(humanizeError(state.resultError));
    } else if (code !== 0 && !state.gotText) {
      finish(humanizeError(stderrBuf || 'Il motore di analisi si è interrotto.'));
    } else if (!state.gotText) {
      // CASO BUG: exit 0 ma nessun testo né errore parsato → l'utente
      // vedrebbe la chip sparire senza alcuna risposta. Loggiamo dettagli
      // e mostriamo un errore utile invece di silenzio.
      log(`BUG: exit 0 senza testo. stdoutBytes=${stdoutBytes} stderrBytes=${stderrBytes}`);
      finish('L\'assistente non ha prodotto una risposta. Riprova; se il problema persiste invia il report diagnostico (?).');
    } else {
      finish(null);
    }
  });
}

// ── Traduce errori tecnici in messaggi comprensibili ─────────────
function humanizeError(raw) {
  const t = String(raw).toLowerCase();
  if (/login|auth|unauthor|not logged|credential/.test(t)) {
    // Spiega ESATTAMENTE come fare login: l'utente apre il terminale del suo
    // sistema, digita `claude`, e segue il browser per l'OAuth.
    const term = IS_WIN ? 'PowerShell' : 'il Terminale';
    return 'Devi accedere al tuo account Claude per usare l\'assistente.\n\n'
         + 'Apri ' + term + ', scrivi:  claude  \ne premi Invio. '
         + 'Si aprirà il browser per il login. Al termine torna qui e riprova.';
  }
  if (/network|econn|timeout|fetch failed|enotfound/.test(t)) {
    return 'Connessione assente o instabile. Controlla la rete e riprova.';
  }
  if (/rate limit|overloaded|529|429/.test(t)) {
    return 'Servizio momentaneamente sovraccarico. Riprova tra poco.';
  }
  return 'Si è verificato un problema durante l\'analisi. Riprova.';
}

// ── Azzera la conversazione (per una "nuova chat") ───────────────
function reset() {
  sessionId = null;
  log('Sessione azzerata');
}

module.exports = { ask, reset, setModel, setLang, setTempDir, findClaudeBinary };
